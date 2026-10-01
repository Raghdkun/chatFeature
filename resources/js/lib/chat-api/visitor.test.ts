import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createVisitorApi,
    isVisitorApiError,
    VisitorApiError,
    type VisitorApi,
} from '@/lib/chat-api/visitor';
import { makeConversationPublic, makeMessage } from '@/lib/chat/fixtures';
import { API, KEY } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/msw/server';

const PAGE = {
    url: 'https://shop.example/pricing',
    title: 'Pricing',
    referrer: '',
};

function client(
    token: string | null = null,
    extra: Partial<Parameters<typeof createVisitorApi>[0]> = {},
): VisitorApi {
    return createVisitorApi({
        base: API,
        widgetKey: KEY,
        token: () => token,
        ...extra,
    });
}

async function failure(promise: Promise<unknown>): Promise<VisitorApiError> {
    try {
        await promise;
    } catch (error) {
        if (isVisitorApiError(error)) {
            return error;
        }

        throw error;
    }

    throw new Error('Expected the request to fail.');
}

describe('session', () => {
    it('creates a session scoped to the widget, without a bearer', async () => {
        const backend = useBackend();
        const session = await client().createSession({
            identity_token: 'jwt',
            visitor: { name: 'Vera' },
            page: PAGE,
            locale: 'en',
        });

        expect(session.visitorToken).toMatch(/^vt_/);
        expect(session.ws).toEqual(backend.ws);
        expect(session.conversation).toBeNull();
        expect(backend.calls[0]).toMatchObject({
            method: 'POST',
            path: `/widgets/${KEY}/sessions`,
            auth: null,
            body: {
                identity_token: 'jwt',
                visitor: { name: 'Vera' },
                page: PAGE,
                locale: 'en',
            },
        });
    });

    it('a returning token goes along as the bearer and is ROTATED: a new token comes back, the old one is revoked, the open chat moves over', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();
        const open = backend.seedConversation(stored.token, 'active');
        const session = await client().createSession(
            { page: PAGE, locale: 'en' },
            stored.token,
        );

        expect(backend.calls[0].auth).toBe(`Bearer ${stored.token}`);
        expect(session.visitorToken).not.toBe(stored.token);
        expect(backend.state.revoked.has(stored.token)).toBe(true);
        expect(session.conversation?.ulid).toBe(open.ulid);

        // the old token is dead, the new one owns the chat
        expect(
            (await failure(client(stored.token).getConversation())).code,
        ).toBe('session_revoked');
        expect(
            (await client(session.visitorToken).getConversation())?.ulid,
        ).toBe(open.ulid);
    });

    it('`ws` is null when Reverb is not configured (the panel stays on REST polling)', async () => {
        useBackend({ noWs: true });

        const session = await client().createSession({
            page: PAGE,
            locale: 'en',
        });

        expect(session.ws).toBeNull();
        expect(session.visitorToken).toMatch(/^vt_/);
    });

    it('a signed identity the server refuses is a 422 with details.identity_token (never retried by the client)', async () => {
        const backend = useBackend();
        const error = await failure(
            client().createSession({
                identity_token: 'bad.jwt',
                page: PAGE,
                locale: 'en',
            }),
        );

        expect(error).toMatchObject({ status: 422, code: 'validation_failed' });
        expect(error.isIdentityRejected).toBe(true);
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
    });

    it('revokes the session with the bearer (204)', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();

        await client(token).revokeSession();
        expect(backend.state.revoked.has(token)).toBe(true);
    });

    it('rejects a session response that lacks the token', async () => {
        server.use(
            http.post(`${API}/widgets/:key/sessions`, () =>
                HttpResponse.json(
                    { data: { visitorToken: 'vt_x' } },
                    { status: 201 },
                ),
            ),
        );

        expect(
            (
                await failure(
                    client().createSession({ page: PAGE, locale: 'en' }),
                )
            ).code,
        ).toBe('invalid_response');
    });
});

describe('bearer and public reads', () => {
    it('sends the bearer on every call after the session, and none on the public config', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);

        await api.getConfig('ar');
        await api.getAvailability();
        await api.getConversation();

        expect(backend.calls.map((c) => c.auth)).toEqual([
            null,
            null,
            `Bearer ${token}`,
        ]);
        expect(backend.calls[0].query.locale).toBe('ar');
    });

    it('unwraps the config and availability data', async () => {
        useBackend();

        const config = await client().getConfig();

        expect(config.key).toBe(KEY);
        expect((await client().getAvailability()).online).toBe(true);
    });

    it('a visitor without a token is told so (401 unauthenticated)', async () => {
        useBackend();

        const error = await failure(client(null).getConversation());

        expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
        expect(error.isSessionGone).toBe(true);
    });
});

describe('error envelope', () => {
    it('maps 409 no_agents and conversation_exists', async () => {
        const backend = useBackend({ noAgents: true });
        const { token } = backend.issueToken();
        const api = client(token);

        expect(
            await failure(api.createConversation({ category: 'billing' })),
        ).toMatchObject({
            status: 409,
            code: 'no_agents',
        });

        backend.state.noAgents = false;
        await api.createConversation({ category: 'billing' });

        expect(
            await failure(api.createConversation({ category: 'billing' })),
        ).toMatchObject({
            status: 409,
            code: 'conversation_exists',
        });
    });

    it('401 session_revoked says the session is gone', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();

        backend.revoke(token);

        const error = await failure(client(token).getConversation());

        expect(error.code).toBe('session_revoked');
        expect(error.isSessionGone).toBe(true);
    });

    it('422 carries field errors', async () => {
        const backend = useBackend({ requireName: true, requireEmail: true });
        const { token } = backend.issueToken();
        const error = await failure(
            client(token).createConversation({ category: 'billing' }),
        );

        expect(error.status).toBe(422);
        expect(error.details).toEqual({
            name: ['The name field is required.'],
            email: ['The email field is required.'],
        });
    });

    it('429 on a write surfaces Retry-After for the UI', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();

        backend.fail(
            'POST',
            '/conversations$',
            429,
            { error: { code: 'rate_limited', message: 'Slow down' } },
            1,
            {
                'Retry-After': '12',
            },
        );

        const error = await failure(
            client(token).createConversation({ category: 'billing' }),
        );

        expect(error).toMatchObject({
            status: 429,
            code: 'rate_limited',
            retryAfter: 12,
        });
    });

    it('a non-JSON error (a proxy page) still becomes a typed error', async () => {
        server.use(
            http.get(
                `${API}/conversation`,
                () =>
                    new HttpResponse('<html>Bad gateway</html>', {
                        status: 502,
                    }),
            ),
        );

        expect(await failure(client('vt_x').getConversation())).toMatchObject({
            status: 502,
            code: 'server_error',
        });
    });

    it('a network failure is code network', async () => {
        server.use(http.get(`${API}/conversation`, () => HttpResponse.error()));

        const error = await failure(client('vt_x').getConversation());

        expect(error.code).toBe('network');
        expect(error.isNetwork).toBe(true);
    });

    it('a malformed success body is invalid_response', async () => {
        server.use(
            http.get(`${API}/conversation`, () =>
                HttpResponse.json({ nope: true }),
            ),
        );

        expect((await failure(client('vt_x').getConversation())).code).toBe(
            'invalid_response',
        );
    });
});

describe('rate limit backoff', () => {
    it('retries a read after Retry-After and then succeeds', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const sleep = vi.fn(async () => undefined);

        backend.fail(
            'GET',
            '/conversation$',
            429,
            { error: { code: 'rate_limited', message: 'x' } },
            2,
            {
                'Retry-After': '2',
            },
        );

        expect(await client(token, { sleep }).getConversation()).toBeNull();
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(2000, undefined);
        expect(backend.callsTo('GET', '/conversation')).toHaveLength(3);
    });

    it('gives up after the retry budget', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const sleep = vi.fn(async () => undefined);

        backend.fail('GET', '/conversation$', 429, undefined, 10, {
            'Retry-After': '1',
        });

        const error = await failure(
            client(token, { sleep, maxRateLimitRetries: 1 }).getConversation(),
        );

        expect(error.status).toBe(429);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not wait for a Retry-After above the cap', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const sleep = vi.fn(async () => undefined);

        backend.fail('GET', '/conversation$', 429, undefined, 1, {
            'Retry-After': '60',
        });

        expect(
            (await failure(client(token, { sleep }).getConversation()))
                .retryAfter,
        ).toBe(60);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries an idempotent message send but not a conversation start', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const sleep = vi.fn(async () => undefined);
        const api = client(token, { sleep });

        await api.createConversation({ category: 'billing' });
        backend.claim();
        backend.fail('POST', '/messages$', 429, undefined, 1, {
            'Retry-After': '1',
        });

        const conversation = backend.state.conversation;

        expect(conversation).not.toBeNull();

        const sent = await api.sendMessage(conversation?.ulid ?? '', {
            client_msg_id: 'c1',
            body: 'Hi',
        });

        expect(sent.message.body).toBe('Hi');
        expect(sleep).toHaveBeenCalledTimes(1);

        backend.close();
        backend.fail('POST', '/conversations$', 429, undefined, 1, {
            'Retry-After': '1',
        });
        expect(
            (await failure(api.createConversation({ category: 'billing' })))
                .status,
        ).toBe(429);
        expect(sleep).toHaveBeenCalledTimes(1);
    });
});

describe('conversation endpoints', () => {
    it('lists messages after a seq and reports the next cursor', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        backend.claim();
        backend.agentSays('One');
        backend.agentSays('Two');

        const first = await api.listMessages(conversation.ulid, {
            afterSeq: 0,
            limit: 2,
        });

        expect(first.messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(first.nextCursor).toBe('2');

        const rest = await api.listMessages(conversation.ulid, { afterSeq: 2 });

        expect(rest.messages.map((m) => m.body)).toEqual(['Two']);
        expect(rest.nextCursor).toBeNull();
        expect(backend.calls.at(-1)?.query).toEqual({ after_seq: '2' });
    });

    it('send is idempotent: a replay answers 200 with the original', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        backend.claim();

        const first = await api.sendMessage(conversation.ulid, {
            client_msg_id: 'same',
            body: 'Hello',
        });
        const again = await api.sendMessage(conversation.ulid, {
            client_msg_id: 'same',
            body: 'Hello',
        });

        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.message.ulid).toBe(first.message.ulid);
        expect(
            backend.state.messages.filter((m) => m.clientMsgId === 'same'),
        ).toHaveLength(1);
    });

    it('a message to a conversation that is not active is 409 conversation_not_active', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        expect(
            await failure(
                api.sendMessage(conversation.ulid, {
                    client_msg_id: 'c1',
                    body: 'Hi',
                }),
            ),
        ).toMatchObject({ status: 409, code: 'conversation_not_active' });
    });

    it('cross-visitor access is a 404', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();

        await client(token).createConversation({ category: 'billing' });

        expect(
            (await failure(client(token).listMessages('someone-elses'))).status,
        ).toBe(404);
    });

    it('receipts, typing, end and rating send their bodies', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        backend.claim();
        await api.sendReceipts(conversation.ulid, {
            delivered_upto: 3,
            seen_upto: 2,
        });
        await api.sendTyping(conversation.ulid, true);

        const ended = await api.endConversation(conversation.ulid);

        expect(ended).toMatchObject({ status: 'ended', ratingRequested: true });

        await api.rateConversation(conversation.ulid, {
            score: 4,
            comment: 'Kind',
        });

        expect(backend.state.receipts).toEqual([
            { delivered_upto: 3, seen_upto: 2 },
        ]);
        expect(backend.state.typing).toEqual([true]);
        expect(backend.state.ratings).toEqual([{ score: 4, comment: 'Kind' }]);
    });

    it('cancelling a queued chat is POST .../cancel (closed); an agent being first is 409 conversation_not_queued', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });
        const cancelled = await api.cancelConversation(conversation.ulid);

        expect(cancelled.status).toBe('closed');
        expect(backend.callsTo('POST', '/cancel')).toHaveLength(1);

        const second = await api.createConversation({ category: 'billing' });

        backend.claim();
        expect(
            await failure(api.cancelConversation(second.ulid)),
        ).toMatchObject({
            status: 409,
            code: 'conversation_not_queued',
        });
    });

    it('ending a queued chat is refused (409 conversation_not_active): cancel is the call for that', async () => {
        const { token } = useBackend().issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        expect(
            await failure(api.endConversation(conversation.ulid)),
        ).toMatchObject({ status: 409, code: 'conversation_not_active' });
    });

    it('rating errors: before the end 409 conversation_not_ended, a second rating 409 already_rated', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        backend.claim();
        expect(
            await failure(
                api.rateConversation(conversation.ulid, { score: 5 }),
            ),
        ).toMatchObject({ status: 409, code: 'conversation_not_ended' });

        await api.endConversation(conversation.ulid);
        await api.rateConversation(conversation.ulid, { score: 5 });
        expect(
            await failure(
                api.rateConversation(conversation.ulid, { score: 4 }),
            ),
        ).toMatchObject({ status: 409, code: 'already_rated' });
    });

    it('skipping the rating is POST .../rating/skip (closed); before the end it is 409 conversation_not_ended', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const api = client(token);
        const conversation = await api.createConversation({
            category: 'billing',
        });

        backend.claim();
        expect(await failure(api.skipRating(conversation.ulid))).toMatchObject({
            status: 409,
            code: 'conversation_not_ended',
        });

        await api.endConversation(conversation.ulid);

        const skipped = await api.skipRating(conversation.ulid);

        expect(skipped.status).toBe('closed');
        expect(backend.callsTo('POST', '/rating/skip')).toHaveLength(2);
    });

    it('feature_disabled (403) is its own typed error', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();

        backend.fail('POST', '/offline-tickets$', 403, {
            error: { code: 'feature_disabled', message: 'Switched off.' },
        });

        expect(
            await failure(
                client(token).createOfflineTicket({
                    name: 'V',
                    email: 'v@x.test',
                    message: 'Hi',
                }),
            ),
        ).toMatchObject({ status: 403, code: 'feature_disabled' });
    });

    it('creates an offline ticket', async () => {
        const backend = useBackend();
        const { token } = backend.issueToken();
        const ticket = await client(token).createOfflineTicket({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Hello',
            missed_conversation: '01ABC',
        });

        expect(ticket).toMatchObject({ type: 'offline', status: 'queued' });
        expect(backend.state.tickets[0]).toMatchObject({
            missed_conversation: '01ABC',
        });
    });

    it('treats a conversation payload without ulid as no conversation', async () => {
        server.use(
            http.get(`${API}/conversation`, () =>
                HttpResponse.json({ data: { foo: 1 } }),
            ),
        );

        expect(await client('vt_x').getConversation()).toBeNull();
        expect(makeConversationPublic().ulid).toBeTruthy();
        expect(makeMessage().seq).toBeGreaterThan(0);
    });
});

/** A minimal XMLHttpRequest stand-in so progress events and error paths are deterministic. */
class FakeXhr {
    static last: FakeXhr;
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
        onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    method = '';
    url = '';
    headers: Record<string, string> = {};
    body: unknown;
    aborted = false;
    responseHeaders: Record<string, string> = {};

    constructor() {
        FakeXhr.last = this;
    }

    open(method: string, url: string): void {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
    }

    getResponseHeader(name: string): string | null {
        return this.responseHeaders[name] ?? null;
    }

    send(body: unknown): void {
        this.body = body;
    }

    abort(): void {
        this.aborted = true;
        this.onabort?.();
    }
}

describe('attachment upload', () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const upload = (options = {}) =>
        createVisitorApi({
            base: API,
            widgetKey: KEY,
            token: () => 'vt_abc',
            xhrFactory: () => new FakeXhr() as unknown as XMLHttpRequest,
        }).uploadAttachment('01CONV', file, options);

    it('posts multipart with the bearer, reports progress, and resolves the attachment', async () => {
        const onProgress = vi.fn();
        const promise = upload({ onProgress });
        const xhr = FakeXhr.last;

        expect(xhr.method).toBe('POST');
        expect(xhr.url).toBe(`${API}/conversations/01CONV/attachments`);
        expect(xhr.headers.Authorization).toBe('Bearer vt_abc');
        expect(xhr.body).toBeInstanceOf(FormData);
        expect((xhr.body as FormData).get('file')).toBeInstanceOf(File);

        xhr.upload.onprogress?.({
            lengthComputable: true,
            loaded: 25,
            total: 100,
        } as ProgressEvent);
        xhr.status = 201;
        xhr.responseText = JSON.stringify({
            data: {
                ulid: '01ATT',
                mime: 'image/webp',
                size: 9,
                width: 1,
                height: 1,
                url: 'https://f/x',
                thumbUrl: null,
            },
        });
        xhr.onload?.();

        expect((await promise).ulid).toBe('01ATT');
        expect(onProgress).toHaveBeenNthCalledWith(1, 0.25);
        expect(onProgress).toHaveBeenLastCalledWith(1);
    });

    it('maps server errors (422 type, 429 with Retry-After) and network failures', async () => {
        const rejected = upload();
        const xhr = FakeXhr.last;

        xhr.status = 422;
        xhr.responseText = JSON.stringify({
            error: {
                code: 'validation_failed',
                message: 'Bad file',
                details: { file: ['Not an image.'] },
            },
        });
        xhr.onload?.();

        expect(await failure(rejected)).toMatchObject({
            status: 422,
            details: { file: ['Not an image.'] },
        });

        const limited = upload();
        const second = FakeXhr.last;

        second.status = 429;
        second.responseHeaders['Retry-After'] = '7';
        second.responseText = '{}';
        second.onload?.();

        expect(await failure(limited)).toMatchObject({
            status: 429,
            code: 'rate_limited',
            retryAfter: 7,
        });

        const broken = upload();

        FakeXhr.last.onerror?.();

        expect((await failure(broken)).code).toBe('network');
    });

    it('abort rejects with code aborted', async () => {
        const abort = new AbortController();
        const promise = upload({ signal: abort.signal });

        abort.abort();

        expect((await failure(promise)).code).toBe('aborted');
        expect(FakeXhr.last.aborted).toBe(true);
    });

    it('an upload response without an attachment is invalid', async () => {
        const promise = upload();
        const xhr = FakeXhr.last;

        xhr.status = 201;
        xhr.responseText = '{"data":{}}';
        xhr.onload?.();

        expect((await failure(promise)).code).toBe('invalid_response');
    });
});
