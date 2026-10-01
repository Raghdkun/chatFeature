import { useRef, useState } from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { useScreenFocus } from '@/embed/hooks/use-screen-focus';
import { flushUi } from '@/tests/embed-render';
import { click, render } from '@/tests/render';

/**
 * A panel whose screens are lazily loaded: after "Go" a skeleton shows up while React keeps the old screen mounted (with its focused
 * control, as it does for a Suspense boundary that suspends again); the real screen with its `data-autofocus` control mounts `late` ms
 * later and the old one goes.
 */
function Harness({ late, open = true }: { late: number; open?: boolean }) {
    const root = useRef<HTMLDivElement>(null);
    const [phase, setPhase] = useState<'first' | 'second'>('first');
    const [shown, setShown] = useState<'first' | 'both' | 'second'>('first');

    useScreenFocus(root, phase, open);

    return (
        <div ref={root}>
            <button
                type="button"
                data-testid="go"
                onClick={() => {
                    setPhase('second');
                    setShown('both');
                    setTimeout(() => setShown('second'), late);
                }}
            >
                Go
            </button>
            {shown !== 'second' ? (
                <input data-testid="first" data-autofocus />
            ) : null}
            {shown === 'both' ? <div data-testid="skeleton" /> : null}
            {shown === 'second' ? (
                <textarea data-testid="second" data-autofocus />
            ) : null}
        </div>
    );
}

const frame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('useScreenFocus', () => {
    it('focuses the first control of the screen when the panel opens', async () => {
        const view = await render(<Harness late={0} />);

        await frame();

        expect(document.activeElement).toBe(view.byTestId('first'));
    });

    it('waits for a screen that mounts after the phase changed (a lazily loaded chunk) and focuses it', async () => {
        const view = await render(<Harness late={80} />);

        await frame();
        await click(view.byTestId('go'));
        await frame();

        // One frame later the skeleton is still up: the new screen is not there yet.
        expect(view.byTestId('skeleton')).not.toBeNull();
        expect(view.byTestId('second')).toBeNull();

        await flushUi(200);

        expect(view.byTestId('second')).not.toBeNull();
        expect(document.activeElement).toBe(view.byTestId('second'));
    });

    it('does nothing while the panel is closed', async () => {
        const view = await render(<Harness late={0} open={false} />);

        await frame();

        expect(document.activeElement).not.toBe(view.byTestId('first'));
    });
});
