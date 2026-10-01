import type { ViewportPayload } from '@/embed/protocol/messages';

/**
 * The keyboard inset for a panel that is the top-level page (hosted page, direct visit): how much of the bottom the on-screen
 * keyboard covers, measured with `visualViewport`. In launcher mode the loader measures this and sends `viewport` messages.
 */
export function measureViewport(win: Window): ViewportPayload {
    const vv = win.visualViewport;

    return {
        width: Math.round(vv?.width ?? win.innerWidth),
        height: Math.round(vv?.height ?? win.innerHeight),
        keyboardInset: vv
            ? Math.max(
                  0,
                  Math.round(
                      win.innerHeight -
                          vv.height * (vv.scale || 1) -
                          vv.offsetTop,
                  ),
              )
            : 0,
    };
}

export function trackViewport(
    win: Window,
    onChange: (viewport: ViewportPayload) => void,
): () => void {
    let frame: number | undefined;
    const run = (): void => {
        frame = undefined;
        onChange(measureViewport(win));
    };
    const schedule = (): void => {
        frame ??= win.requestAnimationFrame(run);
    };

    win.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('scroll', schedule);
    run();

    return () => {
        win.removeEventListener('resize', schedule);
        win.visualViewport?.removeEventListener('resize', schedule);
        win.visualViewport?.removeEventListener('scroll', schedule);

        if (frame !== undefined) {
            win.cancelAnimationFrame(frame);
        }
    };
}
