/**
 * Small form building blocks shared by the builder tabs and the category / agent dialogs.
 * Everything uses logical Tailwind utilities (RTL-safe) and keeps labels, hints and errors wired
 * through `aria-describedby`.
 */
import {
    Check,
    CircleAlert,
    Copy,
    Info,
    Loader2,
    TriangleAlert,
    Zap,
} from 'lucide-react';
import {
    useId,
    useState,
    type ChangeEvent,
    type ComponentProps,
    type ReactNode,
} from 'react';
import { describedBy, Field } from '@/components/setup/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useClipboard } from '@/hooks/use-clipboard';
import { useTrans } from '@/hooks/use-trans';
import {
    clamp,
    contrastGrade,
    contrastRatio,
    formatRatio,
    isHexColor,
    toColorInputValue,
    type ContrastGrade,
} from '@/lib/widget-config';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marks a section whose changes reach visitors as soon as they are saved (settings, greeting
 * messages, domains, categories), unlike the draft design that waits for Publish.
 */
export function LiveBadge() {
    const { t } = useTrans();

    return (
        <span
            data-testid="builder-live-badge"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-sky-300/70 bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200"
        >
            <Zap className="size-3 shrink-0" aria-hidden />
            {t('builder.live.badge')}
        </span>
    );
}

export function SectionCard({
    title,
    description,
    actions,
    live = false,
    children,
    className,
    testId,
}: {
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    /** Show the "Takes effect when you save (no Publish needed)" badge. */
    live?: boolean;
    children: ReactNode;
    className?: string;
    testId?: string;
}) {
    const id = useId();

    return (
        <section
            aria-labelledby={id}
            data-testid={testId}
            data-live={live ? 'true' : undefined}
            className={cn('rounded-xl border bg-card', className)}
        >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
                <div className="grid min-w-0 gap-0.5">
                    <h2
                        id={id}
                        className="text-sm font-semibold tracking-tight"
                    >
                        {title}
                    </h2>
                    {description && (
                        <p className="text-sm text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {(live || actions) && (
                    <div className="flex flex-wrap items-center gap-2">
                        {live && <LiveBadge />}
                        {actions}
                    </div>
                )}
            </header>
            <div className="grid gap-5 p-4 sm:p-5">{children}</div>
        </section>
    );
}

/** A `<fieldset>` with a visible legend, for radio / checkbox groups. */
export function FieldSet({
    legend,
    hideLegend,
    hint,
    error,
    children,
    className,
}: {
    legend: string;
    hideLegend?: boolean;
    hint?: ReactNode;
    error?: string;
    children: ReactNode;
    className?: string;
}) {
    const id = useId();

    return (
        <fieldset
            className={cn('grid min-w-0 content-start gap-2', className)}
            aria-describedby={describedBy(id, { hint, error })}
        >
            <legend
                className={cn(
                    'mb-1 text-sm leading-none font-medium',
                    hideLegend && 'sr-only',
                )}
            >
                {legend}
            </legend>
            {children}
            {hint && (
                <p id={`${id}-hint`} className="text-sm text-muted-foreground">
                    {hint}
                </p>
            )}
            {error && (
                <p
                    id={`${id}-error`}
                    className="text-sm text-red-600 dark:text-red-400"
                >
                    {error}
                </p>
            )}
        </fieldset>
    );
}

/** Spinner glyph for buttons (decorative; the button text carries the meaning). */
export function Busy({ className }: { className?: string }) {
    return (
        <Loader2
            aria-hidden
            className={cn(
                'size-4 animate-spin motion-reduce:animate-none',
                className,
            )}
        />
    );
}

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

const NOTICE_STYLES: Record<NoticeTone, string> = {
    info: 'border-border bg-muted/50 text-foreground',
    warning:
        'border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
    danger: 'border-red-300/70 bg-red-50 text-red-950 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100',
    success:
        'border-emerald-300/70 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100',
};

/** Error messages as red lines under a field or section; renders nothing when there are none. */
export function ErrorLines({
    messages,
    className,
    ...props
}: ComponentProps<'div'> & { messages: readonly string[] }) {
    if (messages.length === 0) {
        return null;
    }

    return (
        <div className={cn('grid gap-0.5', className)} {...props}>
            {messages.map((message) => (
                <p
                    key={message}
                    className="text-sm text-red-600 dark:text-red-400"
                >
                    {message}
                </p>
            ))}
        </div>
    );
}

export function Notice({
    tone = 'info',
    children,
    className,
    ...props
}: ComponentProps<'div'> & { tone?: NoticeTone }) {
    const Icon =
        tone === 'danger'
            ? CircleAlert
            : tone === 'warning'
              ? TriangleAlert
              : tone === 'success'
                ? Check
                : Info;

    return (
        <div
            // A failure must be announced the moment it appears (callers can still override).
            role={tone === 'danger' ? 'alert' : undefined}
            className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
                NOTICE_STYLES[tone],
                className,
            )}
            {...props}
        >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export function TextField({
    id,
    label,
    value,
    onValueChange,
    hint,
    error,
    placeholder,
    maxLength,
    type = 'text',
    disabled,
    required,
    inputMode,
    dir,
    spellCheck,
    autoComplete,
    className,
    inputClassName,
}: {
    id: string;
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    hint?: ReactNode;
    error?: string;
    placeholder?: string;
    maxLength?: number;
    type?: 'text' | 'url' | 'email' | 'search';
    disabled?: boolean;
    required?: boolean;
    inputMode?: ComponentProps<'input'>['inputMode'];
    dir?: 'ltr' | 'rtl' | 'auto';
    spellCheck?: boolean;
    autoComplete?: string;
    className?: string;
    inputClassName?: string;
}) {
    return (
        <div className={className}>
            <Field id={id} label={label} hint={hint} error={error}>
                <Input
                    id={id}
                    type={type}
                    value={value}
                    onChange={(event) => onValueChange(event.target.value)}
                    placeholder={placeholder}
                    maxLength={maxLength}
                    disabled={disabled}
                    required={required}
                    inputMode={inputMode}
                    dir={dir}
                    spellCheck={spellCheck}
                    autoComplete={autoComplete}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, { hint, error })}
                    className={inputClassName}
                />
            </Field>
        </div>
    );
}

/**
 * A whole-number input that never lets an invalid value reach the model: valid numbers in range
 * are dispatched while typing, everything else stays local (with an inline range hint) and is
 * snapped back (or clamped when it was a number out of range) on blur.
 */
export function NumberField({
    id,
    label,
    value,
    onValueChange,
    min,
    max,
    hint,
    error,
    suffix,
    disabled,
    className,
}: {
    id: string;
    label: string;
    value: number;
    onValueChange: (value: number) => void;
    min: number;
    max: number;
    hint?: ReactNode;
    error?: string;
    suffix?: string;
    disabled?: boolean;
    className?: string;
}) {
    const { t } = useTrans();
    const [draft, setDraft] = useState<string | null>(null);
    const text = draft ?? String(value);
    const outOfRange =
        draft !== null &&
        !(/^-?\d+$/.test(draft) && inBounds(Number(draft), min, max));
    const shownError =
        error ??
        (outOfRange ? t('builder.validation.range', { min, max }) : undefined);

    function handleChange(event: ChangeEvent<HTMLInputElement>) {
        const raw = event.target.value;

        setDraft(raw);

        if (/^-?\d+$/.test(raw) && inBounds(Number(raw), min, max)) {
            onValueChange(Number(raw));
        }
    }

    function handleBlur() {
        if (draft !== null && /^-?\d+$/.test(draft)) {
            const clamped = clamp(Number(draft), min, max);

            if (clamped !== value) {
                onValueChange(clamped);
            }
        }

        setDraft(null);
    }

    return (
        <div className={className}>
            <Field id={id} label={label} hint={hint} error={shownError}>
                <div className="flex items-center gap-2">
                    <Input
                        id={id}
                        type="number"
                        inputMode="numeric"
                        min={min}
                        max={max}
                        step={1}
                        value={text}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        disabled={disabled}
                        aria-invalid={shownError ? true : undefined}
                        aria-describedby={describedBy(id, {
                            hint,
                            error: shownError,
                        })}
                        className="max-w-32 tabular-nums"
                    />
                    {suffix && (
                        <span className="text-sm text-muted-foreground">
                            {suffix}
                        </span>
                    )}
                </div>
            </Field>
        </div>
    );
}

function inBounds(value: number, min: number, max: number): boolean {
    return value >= min && value <= max;
}

export function SwitchRow({
    id,
    label,
    description,
    checked,
    onCheckedChange,
    disabled,
    className,
    testId,
}: {
    id: string;
    label: string;
    description?: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
    testId?: string;
}) {
    return (
        <div
            className={cn('flex items-start justify-between gap-4', className)}
        >
            <div className="grid min-w-0 gap-1">
                <Label htmlFor={id} className="leading-snug">
                    {label}
                </Label>
                {description && (
                    <p
                        id={`${id}-description`}
                        className="text-sm text-muted-foreground"
                    >
                        {description}
                    </p>
                )}
            </div>
            <Switch
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
                disabled={disabled}
                aria-describedby={description ? `${id}-description` : undefined}
                data-testid={testId}
                className="mt-0.5"
            />
        </div>
    );
}

export type ChoiceOption<T extends string> = {
    value: T;
    label: string;
    icon?: ReactNode;
    description?: string;
};

/** Segmented radio group built on native radios: arrow keys, form semantics and a11y for free. */
export function SegmentedChoice<T extends string>({
    legend,
    name,
    value,
    options,
    onChange,
    hint,
    error,
    disabled,
    hideLegend,
    variant = 'chips',
    className,
    testId,
}: {
    legend: string;
    name: string;
    value: T;
    options: ChoiceOption<T>[];
    onChange: (value: T) => void;
    hint?: ReactNode;
    error?: string;
    disabled?: boolean;
    hideLegend?: boolean;
    /** `chips`: separate bordered options (descriptive choices). `segmented`: one joined control (short toggles). */
    variant?: 'chips' | 'segmented';
    className?: string;
    testId?: string;
}) {
    const segmented = variant === 'segmented';

    return (
        <FieldSet
            legend={legend}
            hideLegend={hideLegend}
            hint={hint}
            error={error}
            className={className}
        >
            <div
                data-testid={testId}
                className={
                    segmented
                        ? 'inline-flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-0.5'
                        : 'flex flex-wrap gap-2'
                }
            >
                {options.map((option) => (
                    <label
                        key={option.value}
                        className={cn(
                            'inline-flex cursor-pointer items-center gap-2 text-sm font-medium transition-[color,background-color,border-color,box-shadow]',
                            'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                            'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
                            segmented
                                ? 'min-h-8 gap-1.5 rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-sm'
                                : 'min-h-9 rounded-md border border-input bg-background px-3 py-1.5 shadow-xs hover:bg-accent/60 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-accent-foreground',
                        )}
                    >
                        <input
                            type="radio"
                            name={name}
                            value={option.value}
                            checked={option.value === value}
                            disabled={disabled}
                            onChange={() => onChange(option.value)}
                            className="sr-only"
                        />
                        {option.icon}
                        <span>{option.label}</span>
                    </label>
                ))}
            </div>
        </FieldSet>
    );
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

export function ColorField({
    id,
    label,
    value,
    onValueChange,
    hint,
    error,
    className,
}: {
    id: string;
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    hint?: ReactNode;
    error?: string;
    className?: string;
}) {
    const { t } = useTrans();
    const [draft, setDraft] = useState<string | null>(null);
    const text = draft ?? value;
    const invalid = draft !== null && !isHexColor(draft);
    const shownError =
        error ?? (invalid ? t('builder.validation.hex') : undefined);

    function handleText(event: ChangeEvent<HTMLInputElement>) {
        const raw = event.target.value.trim();

        setDraft(raw);

        if (isHexColor(raw)) {
            onValueChange(raw);
        }
    }

    return (
        <div className={className}>
            <Field id={id} label={label} hint={hint} error={shownError}>
                <div className="flex items-center gap-2">
                    <input
                        type="color"
                        aria-label={t('builder.color.pick', { label })}
                        value={toColorInputValue(value)}
                        onChange={(event) => {
                            setDraft(null);
                            onValueChange(event.target.value);
                        }}
                        className="size-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1 shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    />
                    <Input
                        id={id}
                        value={text}
                        onChange={handleText}
                        onBlur={() => setDraft(null)}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoComplete="off"
                        maxLength={9}
                        dir="ltr"
                        aria-invalid={shownError ? true : undefined}
                        aria-describedby={describedBy(id, {
                            hint,
                            error: shownError,
                        })}
                        className="max-w-32 font-mono text-sm uppercase"
                    />
                </div>
            </Field>
        </div>
    );
}

const GRADE_TONE: Record<ContrastGrade, string> = {
    aaa: 'text-emerald-700 dark:text-emerald-300',
    aa: 'text-emerald-700 dark:text-emerald-300',
    large: 'text-amber-700 dark:text-amber-300',
    fail: 'text-red-700 dark:text-red-300',
};

/** "4.8:1 AA": the number and the verdict in words (never colour alone). */
export function ContrastHint({
    foreground,
    background,
    label,
    testId,
}: {
    foreground: string;
    background: string;
    label: string;
    testId?: string;
}) {
    const { t } = useTrans();
    const ratio = contrastRatio(foreground, background);

    if (ratio === null) {
        return null;
    }

    const grade = contrastGrade(ratio);
    const Icon = grade === 'fail' || grade === 'large' ? TriangleAlert : Check;

    return (
        <p
            data-testid={testId}
            data-grade={grade}
            className={cn(
                'flex flex-wrap items-center gap-x-1.5 text-sm',
                GRADE_TONE[grade],
            )}
        >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="font-medium tabular-nums">
                {formatRatio(ratio)}
            </span>
            <span>{t(`builder.contrast.${grade}`)}</span>
            <span className="text-muted-foreground">{label}</span>
        </p>
    );
}

/* -------------------------------------------------------------------------- */
/* Code + copy                                                                */
/* -------------------------------------------------------------------------- */

export function CopyButton({
    value,
    label,
    className,
    testId,
}: {
    value: string;
    label?: string;
    className?: string;
    testId?: string;
}) {
    const { t } = useTrans();
    const [copied, copy] = useClipboard();
    const [failed, setFailed] = useState(false);
    const done = copied === value;

    async function handleClick() {
        setFailed(!(await copy(value)));
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            data-testid={testId}
            className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                className,
            )}
        >
            {done ? (
                <Check className="size-3.5" aria-hidden />
            ) : (
                <Copy className="size-3.5" aria-hidden />
            )}
            <span aria-live="polite">
                {done
                    ? t('builder.copy.done')
                    : failed
                      ? t('builder.copy.failed')
                      : (label ?? t('builder.copy.action'))}
            </span>
        </button>
    );
}

export function CodeBlock({
    title,
    code,
    copyLabel,
    testId,
    className,
}: {
    title: string;
    code: string;
    copyLabel?: string;
    testId?: string;
    className?: string;
}) {
    const id = useId();

    return (
        <div className={cn('grid gap-2', className)}>
            <div className="flex items-center justify-between gap-3">
                <p id={id} className="text-sm font-medium">
                    {title}
                </p>
                <CopyButton
                    value={code}
                    label={copyLabel}
                    testId={testId ? `${testId}-copy` : undefined}
                />
            </div>
            <pre
                tabIndex={0}
                aria-labelledby={id}
                data-testid={testId}
                dir="ltr"
                className="max-h-64 overflow-auto rounded-lg border bg-muted/50 p-3 text-start font-mono text-xs leading-relaxed whitespace-pre focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
                <code>{code}</code>
            </pre>
        </div>
    );
}
