import { useEffect, type RefObject } from 'react';

/** How long (ms) a screen that arrives late (a lazily loaded chunk renders its skeleton first) is still waited for. */
const LATE_SCREEN_MS = 2000;

/**
 * Moves focus into the panel when it opens and into the new screen when the phase changes: the first `[data-autofocus]` control on
 * a fine pointer (so a touch keyboard does not pop up by itself), otherwise the screen's heading (`[data-screen-title]`,
 * `tabIndex=-1`) so a screen reader announces where it is.
 *
 * The conversation and the offline form are lazily loaded: when the phase changes the skeleton is on screen for a moment, with
 * nothing to focus (and the previous screen still mounted, but hidden). The hook therefore looks again as the screen mounts (a mutation
 * observer, for a short while) instead of giving up after one frame, or the control that had focus (the Cancel button of the waiting
 * screen) would vanish and leave focus on the page.
 */
export function useScreenFocus(
    root: RefObject<HTMLElement | null>,
    phase: string,
    open: boolean,
): void {
    useEffect(() => {
        const container = root.current;

        if (!open || container === null) {
            return;
        }

        // The control that has focus as the phase changes belongs to the screen that is going away: it is never the answer.
        const previous = document.activeElement;
        let settled = false;
        const focusScreen = (): void => {
            if (settled) {
                return;
            }

            // A dialog (lightbox, end-chat confirmation) that opened meanwhile owns the focus.
            if (container.querySelector('[aria-modal="true"]') !== null) {
                settled = true;

                return;
            }

            const coarse =
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(pointer: coarse)').matches;
            const target =
                (coarse
                    ? null
                    : container.querySelector<HTMLElement>(
                          '[data-autofocus]',
                      )) ??
                container.querySelector<HTMLElement>('[data-screen-title]');

            // While the next screen loads, React keeps the previous one mounted next to the skeleton (hidden, or still showing its
            // focused control): its first `[data-autofocus]` control is what a lookup finds. That one is skipped, and a control that
            // could not take focus is not "done" either.
            if (target !== null && target !== previous) {
                target.focus({ preventScroll: true });
                settled = target.ownerDocument.activeElement === target;
            }
        };
        const frame = requestAnimationFrame(focusScreen);
        const observer =
            typeof MutationObserver === 'function'
                ? new MutationObserver(focusScreen)
                : null;

        observer?.observe(container, { childList: true, subtree: true });

        const stop = setTimeout(() => observer?.disconnect(), LATE_SCREEN_MS);

        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            clearTimeout(stop);
        };
    }, [root, phase, open]);
}
