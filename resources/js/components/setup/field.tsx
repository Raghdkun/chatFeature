import type { ReactNode } from 'react';
import InputError from '@/components/input-error';
import { Label } from '@/components/ui/label';

/** Ids of the helper/error nodes rendered by {@link Field}, for `aria-describedby`. */
export function describedBy(
    id: string,
    { hint, error }: { hint?: ReactNode; error?: string },
): string | undefined {
    const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
        .filter(Boolean)
        .join(' ');

    return ids === '' ? undefined : ids;
}

/**
 * Label above, control, helper text, then the inline error: the order people read a form.
 * The control gets `id` and `aria-describedby={describedBy(id, { hint, error })}`.
 */
export function Field({
    id,
    label,
    hint,
    error,
    children,
}: {
    id: string;
    label: string;
    hint?: ReactNode;
    error?: string;
    children: ReactNode;
}) {
    return (
        <div className="grid content-start gap-2">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint && (
                <p id={`${id}-hint`} className="text-sm text-muted-foreground">
                    {hint}
                </p>
            )}
            <InputError id={`${id}-error`} message={error} />
        </div>
    );
}
