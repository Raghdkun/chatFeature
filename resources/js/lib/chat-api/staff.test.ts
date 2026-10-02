import { describe, expect, it, vi } from 'vite-plus/test';
import { ApiError, createApiClient } from '@/lib/api-client';
import {
    alreadyClaimedBy,
    ATTACHMENT_MAX_BYTES,
    checkAttachment,
    createStaffApi,
    describeStaffError,
    receiptsBody,
    sendMessageBody,
    staffRoutes,
    transferBody,
    uploadAttachment,
} from '@/lib/chat-api/staff';
import { interpolate } from '@/lib/i18n';
import { FakeXhr } from '@/tests/fake-xhr';
import { en } from '@/tests/lang';

const t = (key: string, replacements?: Record<string, string | number>) =>
    interpolate(en[key] ?? key, replacements);

type Call = { url: string; init: RequestInit };

function clientWith(reply: (call: Call) => Response) {
    const calls: Call[] = [];
    const client = createApiClient({
        fetchImpl: async (input, init) => {
            const url =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            const call = { url, init: init ?? {} };

            calls.push(call);

            return reply(call);
        },
        xsrfToken: () => 'xsrf-1',
        csrfCookieUrl: null,
        onUnauthenticated: () => undefined,
    });

    return { api: createStaffApi(client), calls };
}

const bodyOf = (call: Call): unknown => JSON.parse(call.init.body as string);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

describe('routes', () => {
    it('spells every path of the contract in one place, encoding the ids', () => {
        expect(staffRoutes.api.claim('01ABC')).toBe(
            '/api/v1/conversations/01ABC/claim',
        );
        expect(staffRoutes.api.messages('a/b')).toBe(
            '/api/v1/conversations/a%2Fb/messages',
        );
        expect(staffRoutes.api.heartbeat()).toBe(
            '/api/v1/me/presence/heartbeat',
        );
        expect(staffRoutes.api.export()).toBe('/api/v1/conversations/export');
        expect(staffRoutes.pages.conversation('01ABC')).toBe('/inbox/01ABC');
        expect(staffRoutes.broadcastingAuth()).toBe('/broadcasting/auth');
    });
});

describe('request bodies', () => {
    it('sends client_msg_id always, body and attachments only when present', () => {
        expect(sendMessageBody({ clientMsgId: 'c1', body: 'Hi' })).toEqual({
            client_msg_id: 'c1',
            body: 'Hi',
        });
        expect(
            sendMessageBody({
                clientMsgId: 'c1',
                body: '',
                attachmentUlids: ['a1'],
            }),
        ).toEqual({
            client_msg_id: 'c1',
            attachments: ['a1'],
        });
        expect(
            sendMessageBody({
                clientMsgId: 'c1',
                body: null,
                attachmentUlids: [],
            }),
        ).toEqual({ client_msg_id: 'c1' });
    });

    it('maps a transfer target and receipts onto the snake_case wire names', () => {
        expect(transferBody({ agentId: 9 })).toEqual({ agent_id: 9 });
        expect(transferBody({ category: 'billing' })).toEqual({
            category: 'billing',
        });
        expect(receiptsBody({ deliveredUpto: 4, seenUpto: 3 })).toEqual({
            delivered_upto: 4,
            seen_upto: 3,
        });
        expect(receiptsBody({ seenUpto: 3 })).toEqual({ seen_upto: 3 });
    });
});

describe('the client', () => {
    it('claims with the cookie session and XSRF header and unwraps { data }', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: { ulid: 'c1', status: 'active' } }),
        );

        expect(await api.claim('c1')).toEqual({ ulid: 'c1', status: 'active' });
        expect(calls[0].url).toBe('/api/v1/conversations/c1/claim');
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.credentials).toBe('same-origin');
        expect(calls[0].init.headers).toMatchObject({
            'X-XSRF-TOKEN': 'xsrf-1',
            Accept: 'application/json',
        });
    });

    it('pages messages by after_seq and passes the list filters as a query string', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: [], meta: { next_cursor: null } }),
        );

        await api.messages('c1', { afterSeq: 7, limit: 100 });
        await api.conversations({ status: 'active', type: 'live', limit: 50 });
        await api.queue();

        expect(calls[0].url).toBe(
            '/api/v1/conversations/c1/messages?after_seq=7&limit=100',
        );
        expect(calls[1].url).toBe(
            '/api/v1/conversations?status=active&type=live&limit=50',
        );
        expect(calls[2].url).toBe('/api/v1/conversations/queue');
    });

    it('posts a message with the idempotency key and a transfer with the target', async () => {
        const { api, calls } = clientWith(() => json({ data: {} }, 201));

        await api.sendMessage('c1', { clientMsgId: 'k1', body: 'Hello' });
        await api.transfer('c1', { category: 'sales' });
        await api.receipts('c1', { seenUpto: 5 });
        await api.setPresence('away');

        expect(bodyOf(calls[0])).toEqual({
            client_msg_id: 'k1',
            body: 'Hello',
        });
        expect(bodyOf(calls[1])).toEqual({
            category: 'sales',
        });
        expect(bodyOf(calls[2])).toEqual({
            seen_upto: 5,
        });
        expect(calls[3].init.method).toBe('PUT');
        expect(bodyOf(calls[3])).toEqual({
            status: 'away',
        });
    });

    it('sends going online as automatic and the others as pinned choices', async () => {
        const { api, calls } = clientWith(() => json({ data: {} }));

        await api.setPresence('online');
        await api.setPresence('away');
        await api.setPresence('offline');

        expect(bodyOf(calls[0])).toEqual({
            status: 'online',
            automatic: true,
        });
        expect(bodyOf(calls[1])).toEqual({ status: 'away' });
        expect(bodyOf(calls[2])).toEqual({ status: 'offline' });
    });

    it('says whether the tab is visible with every heartbeat (visible unless told otherwise)', async () => {
        const { api, calls } = clientWith(
            () => new Response(null, { status: 204 }),
        );

        await api.heartbeat();
        await api.heartbeat(false);
        await api.heartbeat(true);

        expect(calls.map((call) => call.init.method)).toEqual([
            'POST',
            'POST',
            'POST',
        ]);
        expect(calls.map((call) => bodyOf(call))).toEqual([
            { visible: true },
            { visible: false },
            { visible: true },
        ]);
    });

    it('accepts a 204 with no body (receipts, heartbeat)', async () => {
        const { api } = clientWith(() => new Response(null, { status: 204 }));

        expect(await api.heartbeat()).toBeNull();
        expect(await api.receipts('c1', { seenUpto: 1 })).toBeNull();
    });
});

describe('errors', () => {
    const claimedError = new ApiError({
        status: 409,
        code: 'already_claimed',
        message: 'Already claimed.',
        details: { by: ['Sam'] },
    });

    it('reads the winner of a lost claim out of the 409 envelope', async () => {
        const { api } = clientWith(() =>
            json(
                {
                    error: {
                        code: 'already_claimed',
                        message: 'Taken.',
                        details: { by: 'Sam' },
                    },
                },
                409,
            ),
        );

        const error = await api.claim('c1').catch((e: unknown) => e);

        expect(alreadyClaimedBy(error)).toEqual({ by: 'Sam' });
    });

    it('is not a claim race for any other error, and tolerates a missing name', () => {
        expect(
            alreadyClaimedBy(
                new ApiError({
                    status: 500,
                    code: 'server_error',
                    message: 'x',
                }),
            ),
        ).toBeNull();
        expect(alreadyClaimedBy(new Error('x'))).toBeNull();
        expect(
            alreadyClaimedBy(
                new ApiError({
                    status: 409,
                    code: 'already_claimed',
                    message: 'x',
                }),
            ),
        ).toEqual({ by: null });
    });

    it("describes the chat errors in the agent's language, and falls back to the shared texts", () => {
        expect(describeStaffError(claimedError, t)).toBe('Taken by Sam');
        expect(
            describeStaffError(
                new ApiError({
                    status: 409,
                    code: 'conversation_not_active',
                    message: 'x',
                }),
                t,
            ),
        ).toBe('This chat is no longer active');
        expect(
            describeStaffError(
                new ApiError({ status: 0, code: 'network', message: 'x' }),
                t,
            ),
        ).toBe(en['widgets.api.error.network']);
        expect(
            describeStaffError(
                new ApiError({
                    status: 409,
                    code: 'something_new',
                    message: 'Server words.',
                }),
                t,
            ),
        ).toBe('Server words.');
    });
});

describe('attachment precheck', () => {
    const file = (type: string, size: number) => ({ type, size });

    it('accepts the four image types up to the size limit', () => {
        for (const type of [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif',
        ]) {
            expect(checkAttachment(file(type, 1000))).toBeNull();
        }

        expect(
            checkAttachment(file('image/png', ATTACHMENT_MAX_BYTES)),
        ).toBeNull();
    });

    it('rejects other types (SVG included) and oversize files before any upload', () => {
        expect(checkAttachment(file('image/svg+xml', 10))).toBe('type');
        expect(checkAttachment(file('application/pdf', 10))).toBe('type');
        expect(checkAttachment(file('', 10))).toBe('type');
        expect(
            checkAttachment(file('image/png', ATTACHMENT_MAX_BYTES + 1)),
        ).toBe('size');
        expect(checkAttachment(file('image/png', 500), 400)).toBe('size');
    });
});

describe('uploadAttachment', () => {
    const png = () => new File(['x'], 'photo.png', { type: 'image/png' });
    const start = (onProgress?: (fraction: number) => void) => {
        FakeXhr.reset();
        const handle = uploadAttachment(
            'c1',
            png(),
            onProgress,
            () => new FakeXhr() as unknown as XMLHttpRequest,
        );

        return { handle, xhr: FakeXhr.last };
    };

    it('posts multipart to the conversation with the XSRF header and reports progress', async () => {
        const progress = vi.fn();
        const { handle, xhr } = start(progress);
        const stored = {
            ulid: 'a1',
            mime: 'image/webp',
            size: 10,
            width: 1,
            height: 1,
            url: 'u',
            thumbUrl: 't',
        };

        expect(xhr.method).toBe('POST');
        expect(xhr.url).toBe('/api/v1/conversations/c1/attachments');
        expect(xhr.headers['Accept']).toBe('application/json');
        expect((xhr.sent as FormData).get('file')).toBeInstanceOf(File);

        xhr.upload.onprogress?.({
            lengthComputable: true,
            loaded: 25,
            total: 100,
        });
        xhr.upload.onprogress?.({
            lengthComputable: false,
            loaded: 0,
            total: 0,
        });
        xhr.reply(201, { data: stored });

        expect(await handle.promise).toEqual(stored);
        expect(progress.mock.calls.map((c) => c[0])).toEqual([0.25, 1]);
    });

    it('turns the error envelope of a rejected upload into an ApiError', async () => {
        const { handle, xhr } = start();

        xhr.reply(422, {
            error: {
                code: 'validation_failed',
                message: 'Bad file.',
                details: { file: ['The file is too large.'] },
            },
        });

        const error = await handle.promise.catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('validation_failed');
        expect((error as ApiError).firstMessage('file')).toBe(
            'The file is too large.',
        );
    });

    it('maps a network failure, an unreadable answer and an abort', async () => {
        const failed = start();

        failed.xhr.onerror?.();
        await expect(failed.handle.promise).rejects.toMatchObject({
            code: 'network',
        });

        const garbled = start();

        garbled.xhr.reply(200, {});
        await expect(garbled.handle.promise).rejects.toMatchObject({
            code: 'invalid_response',
        });

        const cancelled = start();

        cancelled.handle.abort();
        expect(cancelled.xhr.aborted).toBe(true);
        await expect(cancelled.handle.promise).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('names well-known statuses when the body is not an envelope', async () => {
        const { handle, xhr } = start();

        xhr.status = 413;
        xhr.responseText = 'too big';
        xhr.onload?.();

        await expect(handle.promise).rejects.toMatchObject({
            status: 413,
            code: 'request_failed',
        });
    });
});
