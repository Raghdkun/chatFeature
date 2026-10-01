import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    ALLOWED_IMAGE_TYPES,
    MAX_ATTACHMENT_BYTES,
    precheckImage,
} from '@/embed/lib/attachments';
import { newUlid } from '@/embed/lib/ulid';
import { measureViewport, trackViewport } from '@/embed/lib/viewport';
import { loadStoredSession, saveStoredSession } from '@/embed/session/storage';
import { readEmbedBoot } from '@/embed/boot';

describe('attachment precheck', () => {
    it('accepts the four image types up to 5 MB', () => {
        for (const type of ALLOWED_IMAGE_TYPES) {
            expect(precheckImage({ type, name: 'x', size: 1000 })).toEqual({
                ok: true,
            });
        }

        expect(
            precheckImage({
                type: 'image/png',
                name: 'x.png',
                size: MAX_ATTACHMENT_BYTES,
            }),
        ).toEqual({ ok: true });
    });

    it('refuses other types (svg, pdf, html) and files over the limit', () => {
        expect(
            precheckImage({ type: 'image/svg+xml', name: 'x.svg', size: 10 }),
        ).toEqual({ ok: false, reason: 'type' });
        expect(
            precheckImage({ type: 'application/pdf', name: 'x.pdf', size: 10 }),
        ).toEqual({ ok: false, reason: 'type' });
        expect(
            precheckImage({ type: 'text/html', name: 'x.png', size: 10 }),
        ).toEqual({ ok: false, reason: 'type' });
        expect(
            precheckImage({
                type: 'image/png',
                name: 'x.png',
                size: MAX_ATTACHMENT_BYTES + 1,
            }),
        ).toEqual({
            ok: false,
            reason: 'size',
        });
        expect(
            precheckImage(
                { type: 'image/png', name: 'x.png', size: 3000 },
                2000,
            ),
        ).toEqual({ ok: false, reason: 'size' });
    });

    it('falls back to the extension when the browser gives no type (pasted files)', () => {
        expect(
            precheckImage({ type: '', name: 'photo.JPG', size: 10 }),
        ).toEqual({ ok: true });
        expect(
            precheckImage({ type: '', name: 'photo.exe', size: 10 }),
        ).toEqual({ ok: false, reason: 'type' });
        expect(precheckImage({ type: '', name: 'noext', size: 10 })).toEqual({
            ok: false,
            reason: 'type',
        });
    });
});

describe('ulid', () => {
    it('is 26 Crockford characters, time ordered, and unique', () => {
        const a = newUlid(1_700_000_000_000);
        const b = newUlid(1_700_000_001_000);

        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
        expect(new Set(Array.from({ length: 200 }, () => newUlid())).size).toBe(
            200,
        );
    });
});

describe('embed boot data', () => {
    it("reads the shell's inlined object defensively", () => {
        expect(readEmbedBoot(undefined)).toBeNull();
        expect(readEmbedBoot('x')).toBeNull();
        expect(
            readEmbedBoot({ key: '', appOrigin: 'https://a.test' }),
        ).toBeNull();
        expect(readEmbedBoot({ key: 'wk_x' })).toBeNull();
        expect(
            readEmbedBoot({
                key: 'wk_x',
                appOrigin: 'https://a.test',
                allowedHosts: ['a.com', 5],
                preview: 'yes',
                mode: 'weird',
            }),
        ).toEqual({
            key: 'wk_x',
            appOrigin: 'https://a.test',
            allowedHosts: ['a.com'],
            preview: false,
            mode: 'launcher',
        });
        expect(
            readEmbedBoot({
                key: 'wk_x',
                appOrigin: 'https://a.test',
                preview: true,
                mode: 'inline',
            }),
        ).toMatchObject({
            preview: true,
            mode: 'inline',
        });
    });
});

describe('standalone session storage', () => {
    afterEach(() => {
        window.localStorage.clear();
        vi.restoreAllMocks();
    });

    it('round-trips a session and drops expired or corrupt entries', () => {
        const future = new Date(Date.now() + 60_000).toISOString();

        saveStoredSession('wk_x', { token: 'vt_a', expiresAt: future });
        expect(loadStoredSession('wk_x')).toEqual({
            token: 'vt_a',
            expiresAt: future,
        });

        saveStoredSession('wk_x', {
            token: 'vt_a',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect(loadStoredSession('wk_x')).toBeNull();
        expect(
            window.localStorage.getItem('chatfeature:wk_x:session'),
        ).toBeNull();

        window.localStorage.setItem('chatfeature:wk_x:session', '{nope');
        expect(loadStoredSession('wk_x')).toBeNull();

        saveStoredSession('wk_x', { token: 'vt_a', expiresAt: future });
        saveStoredSession('wk_x', null);
        expect(loadStoredSession('wk_x')).toBeNull();
    });

    it('keeps the session in memory when storage is blocked', () => {
        const future = new Date(Date.now() + 60_000).toISOString();

        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        saveStoredSession('wk_mem', { token: 'vt_m', expiresAt: future });

        expect(loadStoredSession('wk_mem')).toEqual({
            token: 'vt_m',
            expiresAt: future,
        });
        saveStoredSession('wk_mem', null);
    });
});

describe('viewport', () => {
    it('measures the keyboard inset from visualViewport', () => {
        const win = {
            innerWidth: 390,
            innerHeight: 800,
            visualViewport: {
                width: 390,
                height: 500,
                scale: 1,
                offsetTop: 0,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            },
        } as unknown as Window;

        expect(measureViewport(win)).toEqual({
            width: 390,
            height: 500,
            keyboardInset: 300,
        });
        expect(
            measureViewport({ innerWidth: 300, innerHeight: 600 } as Window),
        ).toEqual({ width: 300, height: 600, keyboardInset: 0 });
    });

    it('reports changes (once per frame) and stops when disposed', () => {
        const listeners: Record<string, () => void> = {};
        const removeFromWindow = vi.fn();
        const win = {
            innerWidth: 390,
            innerHeight: 800,
            visualViewport: {
                width: 390,
                height: 800,
                scale: 1,
                offsetTop: 0,
                addEventListener: (n: string, f: () => void) =>
                    (listeners[n] = f),
                removeEventListener: vi.fn(),
            },
            addEventListener: vi.fn(),
            removeEventListener: removeFromWindow,
            requestAnimationFrame: (f: () => void) => {
                f();

                return 1;
            },
            cancelAnimationFrame: vi.fn(),
        } as unknown as Window;
        const seen: number[] = [];
        const stop = trackViewport(win, (v) => seen.push(v.keyboardInset));

        (win.visualViewport as { height: number }).height = 480;
        listeners.resize();
        expect(seen).toEqual([0, 320]);

        stop();
        expect(removeFromWindow).toHaveBeenCalled();
    });
});
