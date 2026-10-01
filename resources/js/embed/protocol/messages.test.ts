import { describe, expect, it } from 'vite-plus/test';
import { envelope, parseHostMessage } from '@/embed/protocol/messages';

const wrap = (type: string, payload: unknown, id?: string) => ({
    ns: 'chatfeature',
    v: 1,
    type,
    ...(id === undefined ? {} : { id }),
    payload,
});

describe('parseHostMessage', () => {
    it.each([
        [null],
        ['init'],
        [42],
        [[]],
        [{}],
        [{ ns: 'other', v: 1, type: 'open', payload: {} }],
        [{ ns: 'chatfeature', v: 2, type: 'open', payload: {} }],
        [{ ns: 'chatfeature', v: 1, payload: {} }],
        [{ ns: 'chatfeature', v: 1, type: 7, payload: {} }],
    ])('ignores a malformed envelope: %j', (data) => {
        expect(parseHostMessage(data)).toBeNull();
    });

    it('ignores unknown types silently', () => {
        expect(parseHostMessage(wrap('teleport', {}))).toBeNull();
        expect(parseHostMessage(wrap('init:result', {}))).toBeNull();
        expect(parseHostMessage(wrap('ready', { protocol: 1 }))).toBeNull();
    });

    it('parses init with the id, boot, session, identity, visitor, page and viewport', () => {
        const message = parseHostMessage(
            wrap(
                'init',
                {
                    boot: { key: 'wk_x', api: {} },
                    visitorSession: {
                        token: 'vt_abc',
                        expiresAt: '2026-12-01T00:00:00.000Z',
                    },
                    identityToken: 'jwt',
                    visitor: {
                        name: 'Vera',
                        email: 'v@x.test',
                        meta: { plan: 'pro', n: 3, ok: true, bad: { x: 1 } },
                    },
                    page: {
                        url: 'https://shop.example/',
                        title: 'Shop',
                        referrer: '',
                    },
                    overrides: { locale: 'ar' },
                    embedMode: 'launcher',
                    viewport: { width: 375, height: 700, keyboardInset: 12 },
                },
                'id-1',
            ),
        );

        expect(message).toEqual({
            type: 'init',
            id: 'id-1',
            payload: {
                boot: { key: 'wk_x', api: {} },
                visitorSession: {
                    token: 'vt_abc',
                    expiresAt: '2026-12-01T00:00:00.000Z',
                },
                identityToken: 'jwt',
                visitor: {
                    name: 'Vera',
                    email: 'v@x.test',
                    meta: { plan: 'pro', n: 3, ok: true },
                },
                page: {
                    url: 'https://shop.example/',
                    title: 'Shop',
                    referrer: '',
                },
                overrides: { locale: 'ar' },
                embedMode: 'launcher',
                viewport: { width: 375, height: 700, keyboardInset: 12 },
            },
        });
    });

    it('rejects an init without a boot object and drops a malformed stored session', () => {
        expect(parseHostMessage(wrap('init', {}))).toBeNull();
        expect(parseHostMessage(wrap('init', { boot: 'nope' }))).toBeNull();

        const message = parseHostMessage(
            wrap('init', {
                boot: {},
                visitorSession: { token: '', expiresAt: 'x' },
            }),
        );

        expect(message).toMatchObject({ type: 'init' });
        expect(
            message &&
                'payload' in message &&
                'visitorSession' in message.payload,
        ).toBe(false);
    });

    it('fills init defaults for the optional parts', () => {
        const message = parseHostMessage(wrap('init', { boot: {} }));

        expect(message).toMatchObject({
            payload: {
                page: { url: '', title: '', referrer: '' },
                overrides: {},
                viewport: { width: 0, height: 0, keyboardInset: 0 },
            },
        });
    });

    it('parses the simple commands', () => {
        expect(parseHostMessage(wrap('open', {}))).toEqual({ type: 'open' });
        expect(parseHostMessage(wrap('close', {}))).toEqual({ type: 'close' });
        expect(parseHostMessage(wrap('shutdown', {}))).toEqual({
            type: 'shutdown',
        });
        expect(
            parseHostMessage(
                wrap('update', { overrides: { theme: { radius: 4 } } }),
            ),
        ).toEqual({
            type: 'update',
            payload: { overrides: { theme: { radius: 4 } } },
        });
        expect(parseHostMessage(wrap('update', {}))).toEqual({
            type: 'update',
            payload: { overrides: {} },
        });
        expect(
            parseHostMessage(wrap('setCategory', { slug: 'billing' })),
        ).toEqual({
            type: 'setCategory',
            payload: { slug: 'billing' },
        });
        expect(parseHostMessage(wrap('setCategory', { slug: '' }))).toBeNull();
        expect(parseHostMessage(wrap('setCategory', { slug: 3 }))).toBeNull();
        expect(
            parseHostMessage(
                wrap('startChat', { category: 'tech', message: 'Hi' }),
            ),
        ).toEqual({
            type: 'startChat',
            payload: { category: 'tech', message: 'Hi' },
        });
        expect(
            parseHostMessage(
                wrap('identify', { token: 'jwt', visitor: { name: 'V' } }),
            ),
        ).toEqual({
            type: 'identify',
            payload: { token: 'jwt', visitor: { name: 'V' } },
        });
    });

    it('parses viewport and rejects non-numeric sizes; a negative inset is clamped', () => {
        expect(
            parseHostMessage(
                wrap('viewport', {
                    width: 320,
                    height: 500,
                    keyboardInset: -5,
                }),
            ),
        ).toEqual({
            type: 'viewport',
            payload: { width: 320, height: 500, keyboardInset: 0 },
        });
        expect(
            parseHostMessage(wrap('viewport', { width: '320', height: 500 })),
        ).toBeNull();
        expect(
            parseHostMessage(
                wrap('viewport', { width: Infinity, height: 500 }),
            ),
        ).toBeNull();
    });

    it('parses a builder draft only with a config object', () => {
        expect(
            parseHostMessage(
                wrap('draft', { config: { theme: {} }, greetings: [] }),
            ),
        ).toEqual({
            type: 'draft',
            payload: { config: { theme: {} }, greetings: [] },
        });
        expect(parseHostMessage(wrap('draft', { greetings: [] }))).toBeNull();
    });
});

describe('envelope', () => {
    it('builds the versioned envelope and keeps the id of an answer', () => {
        expect(envelope({ type: 'ready', payload: { protocol: 1 } })).toEqual({
            ns: 'chatfeature',
            v: 1,
            type: 'ready',
            payload: { protocol: 1 },
        });
        expect(
            envelope({ type: 'init:result', payload: {}, id: 'abc' }),
        ).toEqual({
            ns: 'chatfeature',
            v: 1,
            type: 'init:result',
            id: 'abc',
            payload: {},
        });
    });
});
