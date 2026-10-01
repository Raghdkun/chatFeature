import { Direction } from 'radix-ui';
import type { ReactNode } from 'react';
import { useDirection } from '@/hooks/use-direction';

/**
 * Radix primitives (dropdowns, selects, tooltips, sheets) take their direction from a
 * context, not from `<html dir>`. This feeds them the shared `direction` prop and keeps
 * `<html lang dir>` in sync.
 */
export function DirectionProvider({ children }: { children: ReactNode }) {
    const { direction } = useDirection();

    return (
        <Direction.DirectionProvider dir={direction}>
            {children}
        </Direction.DirectionProvider>
    );
}
