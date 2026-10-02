/**
 * A stateful fake of the management chat API (docs/contracts/rest-shapes.md, "Management (Sanctum)"), as MSW handlers: the same
 * paths, envelopes, status codes and error codes the real backend (track 4A) answers with, so the dashboard's data layer is exercised
 * through real `fetch` calls. It is deliberately small, not a re-implementation of the domain: it knows exactly what the dashboard asks.
 *
 *   const backend = createStaffBackend({ conversations: [...] });
 *   const server = setupServer(...backend.handlers);
 */
import { http, HttpResponse } from 'msw';
import { fakeTime, fakeUlid, makeAgentMessage } from '@/lib/chat/fixtures';
import type {
    ConversationStaff,
    MessageData,
    PresenceStatus,
} from '@/lib/chat/types';

export type RecordedCall = {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
};

export type StaffBackendOptions = {
    me?: { id: number; name: string };
    conversations?: ConversationStaff[];
    messages?: Record<string, MessageData[]>;
    presence?: PresenceStatus;
};

const API = '/api/v1';

function envelopeError(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
) {
    return HttpResponse.json(
        { error: { code, message, ...(details ? { details } : {}) } },
        { status },
    );
}

export function createStaffBackend(options: StaffBackendOptions = {}) {
    const me = options.me ?? { id: 7, name: 'Sam' };
    const state = {
        me,
        conversations: new Map<string, ConversationStaff>(
            (options.conversations ?? []).map((c) => [c.ulid, c]),
        ),
        messages: new Map<string, MessageData[]>(
            Object.entries(options.messages ?? {}),
        ),
        presence: options.presence ?? ('offline' as PresenceStatus),
        /** ulid -> the answer of `GET .../transfer-targets`; unset = the endpoint does not exist (404). */
        transferTargets: new Map<string, unknown>(),
        /** The next transfer answers `409 no_agents`. */
        transferNoAgents: false,
        /** ulid -> the colleague who wins the claim race. */
        lostClaims: new Map<string, string>(),
        /** The next N message sends answer 500 (to exercise failed + retry). */
        failNextSends: 0,
        /** Answer every call as if the network were down. */
        offline: false,
        /** The session was revoked: every call is `401 session_revoked`. */
        revoked: false,
        calls: [] as RecordedCall[],
    };

    const record = (request: Request, body?: unknown): RecordedCall => {
        const url = new URL(request.url);
        const call = {
            method: request.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body,
        };

        state.calls.push(call);

        return call;
    };

    const bodyOf = async (
        request: Request,
    ): Promise<Record<string, unknown>> => {
        try {
            return (await request.json()) as Record<string, unknown>;
        } catch {
            return {};
        }
    };

    const find = (ulid: string) => state.conversations.get(ulid);
    const down = () =>
        state.revoked
            ? envelopeError('session_revoked', 'Your session has ended.', 401)
            : state.offline
              ? HttpResponse.error()
              : null;

    const handlers = [
        http.get(`${API}/conversations/queue`, ({ request }) => {
            record(request);

            return (
                down() ??
                HttpResponse.json({
                    data: [...state.conversations.values()].filter(
                        (c) => c.status === 'queued',
                    ),
                    meta: { next_cursor: null },
                })
            );
        }),

        http.get(`${API}/conversations`, ({ request }) => {
            const call = record(request);
            const rows = [...state.conversations.values()].filter(
                (c) =>
                    (!call.query.status || c.status === call.query.status) &&
                    (!call.query.type || c.type === call.query.type),
            );

            return (
                down() ??
                HttpResponse.json({ data: rows, meta: { next_cursor: null } })
            );
        }),

        http.get(`${API}/conversations/:ulid`, ({ request, params }) => {
            record(request);
            const conversation = find(String(params.ulid));

            return (
                down() ??
                (conversation
                    ? HttpResponse.json({ data: conversation })
                    : envelopeError('not_found', 'Not found.', 404))
            );
        }),

        http.get(
            `${API}/conversations/:ulid/messages`,
            ({ request, params }) => {
                const call = record(request);
                const after = Number(call.query.after_seq ?? 0);
                const limit = Number(call.query.limit ?? 100);
                const rows = (state.messages.get(String(params.ulid)) ?? [])
                    .filter((m) => m.seq > after)
                    .sort((a, b) => a.seq - b.seq)
                    .slice(0, limit);

                return (
                    down() ??
                    HttpResponse.json({
                        data: rows,
                        meta: { next_cursor: null },
                    })
                );
            },
        ),

        http.post(`${API}/conversations/:ulid/claim`, ({ request, params }) => {
            record(request);
            const ulid = String(params.ulid);
            const conversation = find(ulid);
            const winner = state.lostClaims.get(ulid);

            const outage = down();

            if (outage) {
                return outage;
            }

            if (!conversation) {
                return envelopeError('not_found', 'Not found.', 404);
            }

            if (winner || conversation.status !== 'queued') {
                return envelopeError(
                    'already_claimed',
                    'Another agent already accepted this chat.',
                    409,
                    {
                        by: winner ?? 'A colleague',
                    },
                );
            }

            const claimed: ConversationStaff = {
                ...conversation,
                status: 'active',
                assignedAgent: { id: me.id, name: me.name },
                agent: { name: me.name, avatarUrl: null },
                claimedAt: new Date().toISOString(),
            };

            state.conversations.set(ulid, claimed);

            return HttpResponse.json({ data: claimed });
        }),

        http.post(
            `${API}/conversations/:ulid/messages`,
            async ({ request, params }) => {
                const ulid = String(params.ulid);
                const body = await bodyOf(request);

                record(request, body);

                const outage = down();

                if (outage) {
                    return outage;
                }

                if (state.failNextSends > 0) {
                    state.failNextSends -= 1;

                    return envelopeError(
                        'server_error',
                        'Something went wrong.',
                        500,
                    );
                }

                const conversation = find(ulid);

                if (!conversation || conversation.status !== 'active') {
                    return envelopeError(
                        'conversation_not_active',
                        'This conversation is not active.',
                        409,
                    );
                }

                const list = state.messages.get(ulid) ?? [];
                const replay = list.find(
                    (m) => m.clientMsgId === body.client_msg_id,
                );

                if (replay) {
                    return HttpResponse.json({ data: replay }, { status: 200 });
                }

                const seq = Math.max(0, ...list.map((m) => m.seq)) + 1;
                const message = makeAgentMessage({
                    ulid: fakeUlid(5000 + seq),
                    seq,
                    conversation: ulid,
                    body: typeof body.body === 'string' ? body.body : null,
                    clientMsgId: String(body.client_msg_id),
                    createdAt: fakeTime(1000 + seq),
                    sender: {
                        type: 'agent',
                        name: me.name,
                        avatarUrl: null,
                        id: me.id,
                    },
                });

                state.messages.set(ulid, [...list, message]);
                state.conversations.set(ulid, {
                    ...conversation,
                    lastSeq: seq,
                    lastMessagePreview: message.body,
                });

                return HttpResponse.json({ data: message }, { status: 201 });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/receipts`,
            async ({ request }) => {
                record(request, await bodyOf(request));

                return down() ?? new HttpResponse(null, { status: 204 });
            },
        ),

        http.post(`${API}/conversations/:ulid/end`, ({ request, params }) => {
            record(request);
            const conversation = find(String(params.ulid));

            if (!conversation || conversation.status !== 'active') {
                return envelopeError(
                    'conversation_not_active',
                    'This conversation is not active.',
                    409,
                );
            }

            const ended = {
                ...conversation,
                status: 'ended' as const,
                ratingRequested: true,
                endedAt: new Date().toISOString(),
            };

            state.conversations.set(conversation.ulid, ended);

            return HttpResponse.json({ data: ended });
        }),

        http.post(`${API}/conversations/:ulid/close`, ({ request, params }) => {
            record(request);
            const conversation = find(String(params.ulid));

            if (!conversation) {
                return envelopeError('not_found', 'Not found.', 404);
            }

            const closed = {
                ...conversation,
                status: 'closed' as const,
                endedAt: new Date().toISOString(),
            };

            state.conversations.set(conversation.ulid, closed);

            return HttpResponse.json({ data: closed });
        }),

        http.get(
            `${API}/conversations/:ulid/transfer-targets`,
            ({ request, params }) => {
                record(request);

                const targets = state.transferTargets.get(String(params.ulid));

                return (
                    down() ??
                    (targets === undefined
                        ? envelopeError('not_found', 'Not found.', 404)
                        : HttpResponse.json({ data: targets }))
                );
            },
        ),

        http.post(
            `${API}/conversations/:ulid/transfer`,
            async ({ request, params }) => {
                const body = await bodyOf(request);

                record(request, body);
                const conversation = find(String(params.ulid));

                if (state.transferNoAgents) {
                    return envelopeError(
                        'no_agents',
                        'Nobody is available for that.',
                        409,
                    );
                }

                if (!conversation || conversation.status !== 'active') {
                    return envelopeError(
                        'conversation_not_active',
                        'This conversation is not active.',
                        409,
                    );
                }

                const requeued: ConversationStaff = {
                    ...conversation,
                    status: 'queued',
                    assignedAgent: null,
                    agent: null,
                };

                state.conversations.set(conversation.ulid, requeued);

                return HttpResponse.json({ data: requeued });
            },
        ),

        http.get(`${API}/me/presence`, ({ request }) => {
            record(request);

            return (
                down() ??
                HttpResponse.json({
                    data: {
                        userId: me.id,
                        status: state.presence,
                        isManual: true,
                        lastSeenAt: null,
                    },
                })
            );
        }),

        http.put(`${API}/me/presence`, async ({ request }) => {
            const body = await bodyOf(request);

            record(request, body);

            const outage = down();

            if (outage) {
                return outage;
            }

            if (!['online', 'away', 'offline'].includes(String(body.status))) {
                return envelopeError('validation_failed', 'Invalid.', 422, {
                    status: ['The selected status is invalid.'],
                });
            }

            state.presence = body.status as PresenceStatus;

            return HttpResponse.json({
                data: {
                    userId: me.id,
                    status: state.presence,
                    isManual: true,
                    lastSeenAt: null,
                },
            });
        }),

        http.post(`${API}/me/presence/heartbeat`, async ({ request }) => {
            record(request, await bodyOf(request));

            return down() ?? new HttpResponse(null, { status: 204 });
        }),

        // The page route that extends the session lifetime (the API does not).
        http.get('/session/keepalive', ({ request }) => {
            record(request);

            return down() ?? new HttpResponse(null, { status: 204 });
        }),
    ];

    return {
        state,
        handlers,
        /** Calls to `METHOD /path`, in order. */
        calls: (method: string, path: string) =>
            state.calls.filter(
                (call) => call.method === method && call.path === path,
            ),
    };
}

export type StaffBackend = ReturnType<typeof createStaffBackend>;
