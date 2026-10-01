import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { useTrans } from '@/hooks/use-trans';
import { addTags, removeTag } from '@/lib/pizzasys-form';
import { cn } from '@/lib/utils';

/**
 * A list of short names (the super roles) edited as chips. Enter or a comma adds what was typed
 * (names may contain spaces), Backspace on an empty field removes the last chip, pasted text is
 * split on commas and new lines, and leaving the field keeps what was typed.
 */
export function TagInput({
    id,
    value,
    onChange,
    placeholder,
    invalid = false,
    describedBy,
    disabled = false,
    testId,
}: {
    id: string;
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    invalid?: boolean;
    describedBy?: string;
    disabled?: boolean;
    testId?: string;
}) {
    const { t } = useTrans();
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const commit = (raw: string) => {
        const next = addTags(value, raw);

        if (next.length !== value.length) {
            onChange(next);
        }

        setDraft('');
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' || event.key === ',') {
            // An empty Enter still submits the surrounding form.
            if (draft.trim() !== '' || event.key === ',') {
                event.preventDefault();
                commit(draft);
            }
        } else if (
            event.key === 'Backspace' &&
            draft === '' &&
            value.length > 0
        ) {
            onChange(value.slice(0, -1));
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData.getData('text');

        if (/[,\n]/.test(text)) {
            event.preventDefault();
            commit(`${draft}${text}`);
        }
    };

    return (
        <div
            // The wrapper only forwards clicks to the real control, so it needs no role of its own.
            onClick={() => inputRef.current?.focus()}
            aria-invalid={invalid ? true : undefined}
            data-testid={testId}
            className={cn(
                'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 shadow-xs transition-[color,box-shadow]',
                'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
                disabled && 'cursor-not-allowed opacity-50',
            )}
        >
            {value.map((tag) => (
                <Badge
                    key={tag}
                    variant="secondary"
                    className="max-w-full gap-1 ps-2 pe-1 font-normal"
                    data-testid={testId ? `${testId}-tag` : undefined}
                >
                    <span className="truncate">{tag}</span>
                    <button
                        type="button"
                        onClick={() => onChange(removeTag(value, tag))}
                        disabled={disabled}
                        aria-label={t('setup.pizzasys.tags.remove', {
                            name: tag,
                        })}
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        <X className="size-3" aria-hidden />
                    </button>
                </Badge>
            ))}
            <input
                ref={inputRef}
                id={id}
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => commit(draft)}
                disabled={disabled}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={value.length === 0 ? placeholder : undefined}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
                className="min-w-24 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
            />
        </div>
    );
}
