import { describe, expect, it } from 'vite-plus/test';
import {
    bareSessionBody,
    isUnsignedFieldRefusal,
    serverSafeSessionBody,
    serverSafeVisitor,
} from '@/embed/session/session-body';
import { VisitorApiError } from '@/lib/chat-api/visitor';

const page = { url: 'https://shop.example/', title: 'Shop', referrer: '' };

describe('serverSafeVisitor', () => {
    it('keeps what the server accepts and drops an optional field it would refuse', () => {
        expect(
            serverSafeVisitor({
                name: ' Ann ',
                email: 'ann@example.com',
                phone: '+1 (555) 010-9999',
                meta: { plan: 'pro', seats: 3, ok: true },
            }),
        ).toEqual({
            name: 'Ann',
            email: 'ann@example.com',
            phone: '+1 (555) 010-9999',
            meta: { plan: 'pro', seats: 3, ok: true },
        });
        expect(serverSafeVisitor({ email: 'nope', phone: 'call me' })).toEqual(
            {},
        );
        expect(serverSafeVisitor({ name: 'n'.repeat(300) }).name).toHaveLength(
            120,
        );
        expect(serverSafeVisitor({ email: `${'a'.repeat(190)}@x.io` })).toEqual(
            {},
        );
        expect(serverSafeVisitor({ phone: '1'.repeat(41) })).toEqual({});
    });

    it('filters meta keys and oversized values, at most 20 entries', () => {
        const meta: Record<string, string> = {
            'bad key!': 'x',
            long: 'v'.repeat(501),
        };

        for (let i = 0; i < 30; i++) {
            meta[`k${i}`] = 'v';
        }

        const out = serverSafeVisitor({ meta }).meta ?? {};

        expect(out).not.toHaveProperty('bad key!');
        expect(out).not.toHaveProperty('long');
        expect(Object.keys(out).length).toBeLessThanOrEqual(20);
    });
});

describe('serverSafeSessionBody', () => {
    it("caps the page fields at the server's limits and never sends an empty visitor", () => {
        const body = serverSafeSessionBody({
            page: {
                url: `https://x/${'u'.repeat(3000)}`,
                title: 'T'.repeat(400),
                referrer: 'r'.repeat(3000),
            },
            visitor: { email: 'broken' },
            locale: 'en',
        });

        expect(body.page.title).toHaveLength(255);
        expect(body.page.url).toHaveLength(2048);
        expect(body.page.referrer).toHaveLength(2048);
        expect(body).not.toHaveProperty('visitor');
    });

    it('bareSessionBody keeps only the signed identity', () => {
        expect(
            bareSessionBody({
                identity_token: 'a.b.c',
                visitor: { name: 'Ann' },
                page,
                locale: 'ar',
            }),
        ).toEqual({
            identity_token: 'a.b.c',
            page: { url: '', title: '', referrer: '' },
            locale: 'en',
        });
    });
});

describe('isUnsignedFieldRefusal', () => {
    const refusal = (details: Record<string, string[]>, status = 422) =>
        new VisitorApiError({
            status,
            code: 'validation_failed',
            message: 'x',
            details,
        });

    it('is true only for a 422 that blames the optional fields alone', () => {
        expect(
            isUnsignedFieldRefusal(refusal({ 'visitor.email': ['bad'] })),
        ).toBe(true);
        expect(
            isUnsignedFieldRefusal(
                refusal({ 'page.title': ['x'], locale: ['y'] }),
            ),
        ).toBe(true);
        expect(
            isUnsignedFieldRefusal(
                refusal({ identity_token: ['bad'], 'visitor.name': ['x'] }),
            ),
        ).toBe(false);
        expect(isUnsignedFieldRefusal(refusal({}))).toBe(false);
        expect(
            isUnsignedFieldRefusal(refusal({ 'visitor.email': ['bad'] }, 429)),
        ).toBe(false);
    });
});
