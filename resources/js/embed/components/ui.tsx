import { useId, type ReactNode } from 'react';
import { AlertCircle } from '@/embed/components/icons';

type ButtonProps = React.ComponentProps<'button'> & {
    variant?: 'primary' | 'quiet' | 'ghost';
    busy?: boolean;
    block?: boolean;
};

const BASE =
    'pne-press pne-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-55';

const VARIANTS = {
    primary: 'bg-brand text-on-brand pne-hover-fill',
    quiet: 'bg-muted text-ink border border-line pne-hover-lift',
    ghost: 'text-ink pne-hover-dim',
} as const;

export function Button({
    variant = 'primary',
    busy = false,
    block = false,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
}: ButtonProps) {
    return (
        <button
            type={type}
            className={`${BASE} ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            {...rest}
        >
            {busy ? <span className="pne-spinner" aria-hidden="true" /> : null}
            {children}
        </button>
    );
}

/** A 40x40 icon button (44 on touch through padding of the hit area). */
export function IconButton({
    label,
    children,
    className = '',
    ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            className={`pne-press pne-focus pne-hover-dim grid size-10 shrink-0 place-items-center rounded-full ${className}`}
            {...rest}
        >
            {children}
        </button>
    );
}

type FieldProps = {
    label: string;
    optionalLabel?: string | null;
    error?: string | null;
    children: (props: {
        id: string;
        'aria-invalid': true | undefined;
        'aria-describedby': string | undefined;
    }) => ReactNode;
};

/** Label + control + inline error, wired with `aria-invalid` / `aria-describedby`. */
export function Field({ label, optionalLabel, error, children }: FieldProps) {
    const id = useId();
    const errorId = `${id}-error`;

    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-[13px] font-semibold">
                {label}
                {optionalLabel ? (
                    <span className="text-subtle ms-1 font-normal">
                        {optionalLabel}
                    </span>
                ) : null}
            </label>
            {children({
                id,
                'aria-invalid': error ? true : undefined,
                'aria-describedby': error ? errorId : undefined,
            })}
            {error ? (
                <p
                    id={errorId}
                    className="text-danger flex items-start gap-1.5 text-[13px]"
                >
                    <AlertCircle
                        aria-hidden="true"
                        className="mt-0.5 size-3.5 shrink-0"
                    />
                    <span>{error}</span>
                </p>
            ) : null}
        </div>
    );
}

export const INPUT_CLASS =
    'pne-focus bg-surface text-ink border-line placeholder:text-subtle block min-h-11 w-full rounded-md border px-3 py-2 text-[15px] transition-colors duration-150 aria-[invalid=true]:border-danger focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30';

export function Avatar({
    name,
    url,
    size = 36,
}: {
    name: string | null;
    url: string | null;
    size?: number;
}) {
    const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';

    return (
        <span
            aria-hidden="true"
            className="bg-muted-strong text-ink relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold"
            style={{ inlineSize: size, blockSize: size }}
        >
            {url ? (
                <img
                    src={url}
                    alt=""
                    className="size-full object-cover"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                />
            ) : (
                initial
            )}
        </span>
    );
}

/** A visible banner for a failure the visitor can act on. */
export function Banner({
    children,
    tone = 'danger',
}: {
    children: ReactNode;
    tone?: 'danger' | 'info';
}) {
    return (
        <div
            role={tone === 'danger' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] ${
                tone === 'danger'
                    ? 'border-danger/40 text-danger bg-danger/10'
                    : 'border-line text-ink bg-muted'
            }`}
        >
            <AlertCircle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
            />
            <span>{children}</span>
        </div>
    );
}
