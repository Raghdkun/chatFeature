import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ControllerContext } from '@/embed/components/context';
import {
    isChunkFailure,
    PanelErrorBoundary,
    panelPage,
} from '@/embed/components/error-boundary';
import { lazyRetry } from '@/embed/components/lazy';
import { useBackend } from '@/tests/msw/server';
import { createHarness } from '@/tests/embed-harness';
import { flushUi } from '@/tests/embed-render';
import { click, render } from '@/tests/render';

function Hello() {
    return <p data-testid="loaded">The chunk is here</p>;
}

describe('the panel error boundary', () => {
    it('recognises the chunk-load failures of the three engines, and nothing else', () => {
        expect(
            isChunkFailure(
                new TypeError(
                    'Failed to fetch dynamically imported module: https://app.test/build/assets/chat-screen-1.js',
                ),
            ),
        ).toBe(true);
        expect(
            isChunkFailure(
                new Error('error loading dynamically imported module'),
            ),
        ).toBe(true);
        expect(
            isChunkFailure(new Error('Importing a module script failed.')),
        ).toBe(true);
        expect(isChunkFailure(new Error('render failed'))).toBe(false);
        expect(
            isChunkFailure('Failed to fetch dynamically imported module'),
        ).toBe(false);
    });

    it('a chunk that failed to load reloads the panel on "Try again" (Chromium never imports a failed chunk again)', async () => {
        useBackend();

        const h = createHarness();
        const load = vi
            .fn<() => Promise<{ default: typeof Hello }>>()
            .mockRejectedValue(
                new TypeError('Failed to fetch dynamically imported module'),
            );
        const Chat = lazyRetry<object>(load);
        const reload = vi
            .spyOn(panelPage, 'reload')
            .mockImplementation(() => undefined);
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        try {
            const view = await render(
                <ControllerContext.Provider value={h.controller}>
                    <PanelErrorBoundary>
                        <Suspense fallback={<p>loading</p>}>
                            <Chat />
                        </Suspense>
                    </PanelErrorBoundary>
                </ControllerContext.Provider>,
            );

            await flushUi();
            expect(view.byTestId('panel-error')).not.toBeNull();

            await click(view.byTestId('panel-error-retry'));
            await flushUi();

            expect(reload).toHaveBeenCalledTimes(1);
            // The in-place retry would only fail the same way: the chunk was not asked for again.
            expect(load).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
            reload.mockRestore();
        }
    });

    it('a rejected lazy import shows "Try again", and trying again fetches the chunk once more', async () => {
        useBackend();

        const h = createHarness();
        const load = vi
            .fn<() => Promise<{ default: typeof Hello }>>()
            .mockRejectedValueOnce(new Error('the chunk is corrupt'))
            .mockResolvedValue({ default: Hello });
        const Chat = lazyRetry<object>(load);
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        try {
            const view = await render(
                <ControllerContext.Provider value={h.controller}>
                    <PanelErrorBoundary>
                        <Suspense fallback={<p>loading</p>}>
                            <Chat />
                        </Suspense>
                    </PanelErrorBoundary>
                </ControllerContext.Provider>,
            );

            await flushUi();

            expect(view.byTestId('panel-error')).not.toBeNull();
            expect(view.text()).toContain("This part of the chat didn't load.");
            expect(view.byTestId('loaded')).toBeNull();

            await click(view.byTestId('panel-error-retry'));
            await flushUi();

            expect(view.byTestId('panel-error')).toBeNull();
            expect(view.byTestId('loaded')).not.toBeNull();
            expect(load).toHaveBeenCalledTimes(2);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('a screen that throws while rendering is contained, and a new reset key clears the failure', async () => {
        useBackend();

        const h = createHarness();
        let explode = true;
        const Broken = () => {
            if (explode) {
                throw new Error('render failed');
            }

            return <Hello />;
        };
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const tree = (key: string) => (
            <ControllerContext.Provider value={h.controller}>
                <PanelErrorBoundary resetKey={key}>
                    <Broken />
                </PanelErrorBoundary>
            </ControllerContext.Provider>
        );

        try {
            const view = await render(tree('a'));

            expect(view.byTestId('panel-error')).not.toBeNull();

            explode = false;
            await click(view.byTestId('panel-error-retry'));
            expect(view.byTestId('loaded')).not.toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });
});
