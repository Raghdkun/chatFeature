import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ControllerContext } from '@/embed/components/context';
import { PanelErrorBoundary } from '@/embed/components/error-boundary';
import { lazyRetry } from '@/embed/components/lazy';
import { useBackend } from '@/tests/msw/server';
import { createHarness } from '@/tests/embed-harness';
import { flushUi } from '@/tests/embed-render';
import { click, render } from '@/tests/render';

function Hello() {
    return <p data-testid="loaded">The chunk is here</p>;
}

describe('the panel error boundary', () => {
    it('a rejected lazy import shows "Try again", and trying again fetches the chunk once more', async () => {
        useBackend();

        const h = createHarness();
        const load = vi
            .fn<() => Promise<{ default: typeof Hello }>>()
            .mockRejectedValueOnce(
                new Error('Failed to fetch dynamically imported module'),
            )
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
