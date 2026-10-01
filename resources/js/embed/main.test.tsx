import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { act } from 'react';
import '@/tests/dom-polyfills';
import { click } from '@/tests/render';
import { fill } from '@/tests/dom';
import { useBackend } from '@/tests/msw/server';
import { KEY } from '@/tests/msw/chat-visitor';
import { waitFor } from '@/tests/embed-render';

const byTestId = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/**
 * The entry as the hosted page (`/c/{key}`) and a direct visit run it: no parent window, so no loader, so the panel boots itself
 * (public config fetch), keeps the session in its own storage and counts as open.
 */
describe('standalone boot (hosted page)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="chat-root"></div>';
        window.localStorage.clear();
        vi.resetModules();
    });
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('boots from the public config, starts a chat, and keeps the session in localStorage', async () => {
        const backend = useBackend();

        (window as unknown as { __PNE_EMBED__: unknown }).__PNE_EMBED__ = {
            key: KEY,
            appOrigin: 'https://chat.test',
            allowedHosts: [],
            preview: false,
            mode: 'hosted',
        };

        await act(async () => {
            await import('@/embed/main');
        });
        await waitFor(() => byTestId('prechat-form') !== null);

        expect(document.documentElement.dataset.mode).toBe('hosted');
        expect(byTestId('chat-state')?.dataset.state).toBe('prechat');
        // no host: no close button
        expect(
            document.querySelector('header button[aria-label="Close chat"]'),
        ).toBeNull();
        expect(backend.callsTo('GET', '/config')).toHaveLength(1);

        await fill(document.querySelector('input[name="name"]'), 'Vera');
        await click(document.querySelector('button[type="submit"]'));
        await click(byTestId('category-option-billing'));
        await waitFor(() => byTestId('chat-state')?.dataset.state === 'queued');

        const stored = JSON.parse(
            window.localStorage.getItem(`chatfeature:${KEY}:session`) ?? 'null',
        ) as { token: string };

        expect(stored.token).toMatch(/^vt_/);
    });

    it('resumes a stored session on reload', async () => {
        const backend = useBackend();
        const { token, expiresAt } = backend.issueToken();

        backend.seedConversation(token, 'queued');
        window.localStorage.setItem(
            `chatfeature:${KEY}:session`,
            JSON.stringify({ token, expiresAt }),
        );
        (window as unknown as { __PNE_EMBED__: unknown }).__PNE_EMBED__ = {
            key: KEY,
            appOrigin: 'https://chat.test',
            allowedHosts: [],
            preview: false,
            mode: 'launcher',
        };

        await act(async () => {
            await import('@/embed/main');
        });
        await waitFor(() => byTestId('chat-state')?.dataset.state === 'queued');

        // a launcher page that was opened directly has no loader either: it behaves like the hosted page
        expect(document.documentElement.dataset.mode).toBe('hosted');
        expect(byTestId('queued-cancel')).not.toBeNull();

        // resuming a live chat rotated the token: the page's own storage holds the new one, the old one is dead
        const stored = JSON.parse(
            window.localStorage.getItem(`chatfeature:${KEY}:session`) ?? 'null',
        ) as { token: string };

        expect(stored.token).not.toBe(token);
        expect(stored.token).toBe(backend.state.rotated.get(token));
        expect(backend.state.revoked.has(token)).toBe(true);
    });

    it('a widget that cannot be loaded shows the unavailable screen', async () => {
        useBackend().fail(
            'GET',
            '/config$',
            404,
            { error: { code: 'widget_not_found', message: 'x' } },
            5,
        );
        (window as unknown as { __PNE_EMBED__: unknown }).__PNE_EMBED__ = {
            key: KEY,
            appOrigin: 'https://chat.test',
            allowedHosts: [],
            preview: false,
            mode: 'hosted',
        };

        await act(async () => {
            await import('@/embed/main');
        });
        await waitFor(
            () =>
                document.body.textContent?.includes(
                    'Chat is not available right now.',
                ) === true,
        );
    });

    it('does nothing without boot data', async () => {
        (window as unknown as { __PNE_EMBED__?: unknown }).__PNE_EMBED__ =
            undefined;
        await import('@/embed/main');

        expect(document.querySelector('[data-testid="chat-panel"]')).toBeNull();
    });
});
