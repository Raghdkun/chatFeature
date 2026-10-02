import { describe, expect, it } from 'vite-plus/test';
import {
    formatRemaining,
    handoffDeadline,
    remainingMs,
    remainingUntil,
    spacedCode,
    whatsAppHref,
} from '@/embed/lib/whatsapp';

describe('whatsAppHref', () => {
    it.each([
        'https://wa.me/491701234567?text=K7M2QX4P',
        'https://api.whatsapp.com/send?phone=491701234567&text=K7M2QX4P',
        'https://web.whatsapp.com/send?phone=491701234567',
    ])('lets a WhatsApp https link through: %s', (link) => {
        expect(whatsAppHref(link)).toBe(new URL(link).toString());
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'http://wa.me/491701234567',
        'https://evil.example/wa.me/491701234567',
        'https://wa.me.evil.example/491701234567',
        'https://user:secret@wa.me/491701234567',
        'https://wa.me@evil.example/491701234567',
        '//wa.me/491701234567',
        'wa.me/491701234567',
        '',
        'not a url',
    ])('refuses %j', (link) => {
        expect(whatsAppHref(link)).toBeNull();
    });
});

describe('remainingMs', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');

    it('is the time left, never negative', () => {
        expect(remainingMs('2026-11-20T10:30:00Z', now)).toBe(30 * 60_000);
        expect(remainingMs('2026-11-20T10:00:00Z', now)).toBe(0);
        expect(remainingMs('2026-11-20T09:00:00Z', now)).toBe(0);
    });

    it('is null for something that is not a time', () => {
        expect(remainingMs('soon', now)).toBeNull();
        expect(remainingMs('', now)).toBeNull();
    });
});

describe('handoffDeadline', () => {
    const arrived = Date.parse('2026-11-20T10:00:00Z');
    const expiresAt = '2026-11-21T10:00:00Z';

    it('counts the server\u2019s ttl from the arrival of the answer, whatever the clocks say', () => {
        expect(handoffDeadline({ expiresAt, ttlSeconds: 600 }, arrived)).toBe(
            arrived + 600_000,
        );
        // Even an expiresAt in the distant past (a skewed clock) is ignored.
        expect(
            handoffDeadline(
                { expiresAt: '2001-01-01T00:00:00Z', ttlSeconds: 86_400 },
                arrived,
            ),
        ).toBe(arrived + 86_400_000);
    });

    it('uses expiresAt for an older server, and says "no expiry" for a code that is already past on arrival (clock skew)', () => {
        expect(handoffDeadline({ expiresAt }, arrived)).toBe(
            Date.parse(expiresAt),
        );
        expect(handoffDeadline({ expiresAt }, arrived + 2 * 86_400_000)).toBe(
            null,
        );
        expect(handoffDeadline({ expiresAt: 'soon' }, arrived)).toBeNull();
    });

    it('ignores a ttl that is not a positive number', () => {
        for (const ttlSeconds of [0, -5, Number.NaN, null, undefined]) {
            expect(handoffDeadline({ expiresAt, ttlSeconds }, arrived)).toBe(
                Date.parse(expiresAt),
            );
        }
    });
});

describe('remainingUntil', () => {
    it('is the time left, never negative, and nothing without a deadline', () => {
        expect(remainingUntil(1_000, 400)).toBe(600);
        expect(remainingUntil(1_000, 5_000)).toBe(0);
        expect(remainingUntil(null, 5_000)).toBeNull();
    });
});

describe('formatRemaining', () => {
    it('counts minutes below two hours, rounding up so a code with seconds left still has a minute', () => {
        expect(formatRemaining(1, 'en')).toBe('1 minute');
        expect(formatRemaining(59_000, 'en')).toBe('1 minute');
        expect(formatRemaining(61_000, 'en')).toBe('2 minutes');
        expect(formatRemaining(45 * 60_000, 'en')).toBe('45 minutes');
        expect(formatRemaining(119 * 60_000, 'en')).toBe('119 minutes');
    });

    it('counts whole hours from two hours up', () => {
        expect(formatRemaining(120 * 60_000, 'en')).toBe('2 hours');
        expect(formatRemaining(23 * 3_600_000 + 30 * 60_000, 'en')).toBe(
            '23 hours',
        );
    });

    it('writes the unit in the visitor language', () => {
        expect(formatRemaining(5 * 60_000, 'de')).toMatch(/5\s+Minuten/);
        expect(formatRemaining(5 * 60_000, 'ar')).not.toMatch(/minutes/);
    });

    it('falls back to English words when the locale is not a locale', () => {
        expect(formatRemaining(3 * 60_000, 'not a locale!')).toBe('3 minutes');
        expect(formatRemaining(60_000, 'not a locale!')).toBe('1 minute');
    });
});

describe('spacedCode', () => {
    it('splits an eight character code in two halves', () => {
        expect(spacedCode('K7M2QX4P')).toBe('K7M2 QX4P');
    });

    it('leaves any other length alone', () => {
        expect(spacedCode('K7M2')).toBe('K7M2');
        expect(spacedCode('')).toBe('');
    });
});
