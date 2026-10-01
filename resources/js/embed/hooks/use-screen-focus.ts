import { useEffect, type RefObject } from 'react';

/**
 * Moves focus into the panel when it opens and into the new screen when the phase changes: the first `[data-autofocus]` control on
 * a fine pointer (so a touch keyboard does not pop up by itself), otherwise the screen's heading (`[data-screen-title]`,
 * `tabIndex=-1`) so a screen reader announces where it is.
 */
export function useScreenFocus(
    root: RefObject<HTMLElement | null>,
    phase: string,
    open: boolean,
): void {
    useEffect(() => {
        if (!open) {
            return;
        }

        const frame = requestAnimationFrame(() => {
            const container = root.current;

            if (container === null) {
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

            target?.focus({ preventScroll: true });
        });

        return () => cancelAnimationFrame(frame);
    }, [root, phase, open]);
}
