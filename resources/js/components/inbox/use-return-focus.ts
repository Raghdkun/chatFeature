import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Radix returns focus to the dialog's own `Trigger` when it closes. Our dialogs are controlled (opened by a button elsewhere, or by a
 * toolbar action) and have no Trigger, so without this focus would fall to the page body and a keyboard user would start again from
 * the top. Remember what had focus when the dialog opened (a layout effect runs before Radix moves focus inside) and give it back on
 * close; if that element is gone (ending a chat removes its own button) land on the main content region instead.
 *
 *   <DialogContent {...useReturnFocus(open)}>
 */
export function useReturnFocus(open: boolean): {
    onCloseAutoFocus: () => void;
} {
    const origin = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
        if (open) {
            origin.current =
                document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
        }
    }, [open]);

    const onCloseAutoFocus = useCallback(() => {
        const element = origin.current;
        const target =
            element && document.contains(element)
                ? element
                : document.getElementById('main-content');

        target?.focus({ preventScroll: true });
    }, []);

    return { onCloseAutoFocus };
}
