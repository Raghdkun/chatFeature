import { Link } from '@inertiajs/react';
import { SendHorizontal } from 'lucide-react';
import {
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react';
import { useNow } from '@/components/inbox/use-now';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { waitLabel } from '@/lib/whatsapp-api/client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import { WA_LIMITS } from '@/lib/whatsapp-api/types';
import type { ComposerBlock } from '@/lib/whatsapp/transcript';
import { cn } from '@/lib/utils';

/** The textarea grows with its content up to this height (about eight lines), then scrolls. */
const MAX_HEIGHT_PX = 176;

/**
 * The reply box: an auto-growing textarea (Enter sends, Shift+Enter breaks the line, an IME composition is left alone), a length counter,
 * a pause after the server asked to slow down (`Retry-After`), and a quiet reason in place of the box when a reply cannot go out at all
 * (the session is not connected, or the customer has not written first). Plain text only: WhatsApp replies carry no attachments here.
 */
export function WaComposer({
    chat,
    block,
    pausedUntil,
    onSend,
}: {
    /** The chat's ulid: a new chat starts with an empty box. */
    chat: string;
    block: ComposerBlock | null;
    /** The time (ms since the epoch) sending resumes after a `429 Retry-After`; `null` when not paused. */
    pausedUntil: number | null;
    onSend: (body: string) => Promise<void>;
}) {
    const { t, locale } = useTrans();
    const now = useNow();
    const inputId = useId();
    const countId = useId();
    const [value, setValue] = useState('');
    const area = useRef<HTMLTextAreaElement>(null);
    const blocked = block !== null;
    const remaining =
        pausedUntil === null
            ? 0
            : Math.max(0, Math.ceil((pausedUntil - now) / 1000));
    const paused = remaining > 0;
    const canSend = !blocked && !paused && value.trim() !== '';
    const max = WA_LIMITS.messageMax;
    const nearLimit = value.length > max * 0.9;

    // A pointer-and-keyboard device lands in the box when a chat opens; a phone does not (it would raise the keyboard over the chat).
    useEffect(() => {
        if (!blocked && window.matchMedia?.('(pointer: fine)').matches) {
            area.current?.focus();
        }
        // Only when the chat opens (or becomes writable), not on every keystroke.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocked, chat]);

    useLayoutEffect(() => {
        const element = area.current;

        if (element) {
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
        }
    }, [value]);

    const submit = async (): Promise<void> => {
        if (!canSend) {
            return;
        }

        const body = value;

        setValue('');
        area.current?.focus();
        await onSend(body);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
        ) {
            event.preventDefault();
            void submit();
        }
    };

    return (
        <div
            data-testid="wa-composer"
            className="border-t bg-background px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
        >
            {block !== null ? (
                <p
                    data-testid="wa-composer-disabled"
                    data-reason={block}
                    role="status"
                    className="rounded-lg bg-muted px-3 py-3 text-center text-sm text-muted-foreground"
                >
                    {block === 'session_not_ready' ? (
                        <>
                            {t('whatsapp.composer.disabled.session')}{' '}
                            <Link
                                href={waRoutes.pages.settings()}
                                className="font-medium text-foreground underline underline-offset-2"
                            >
                                {t('whatsapp.composer.open_settings')}
                            </Link>
                        </>
                    ) : (
                        t('whatsapp.composer.disabled.inbound')
                    )}
                </p>
            ) : (
                <>
                    {paused && (
                        <p
                            data-testid="wa-composer-paused"
                            role="status"
                            className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-400/10 dark:text-amber-100"
                        >
                            {t('whatsapp.composer.paused', {
                                wait: waitLabel(remaining, locale),
                            })}
                        </p>
                    )}
                    <div className="flex items-end gap-1.5 rounded-2xl border bg-background p-1.5 shadow-xs transition-[box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
                        <label htmlFor={inputId} className="sr-only">
                            {t('whatsapp.composer.label')}
                        </label>
                        <textarea
                            id={inputId}
                            ref={area}
                            rows={1}
                            value={value}
                            maxLength={max}
                            data-testid="wa-composer-input"
                            aria-describedby={countId}
                            placeholder={t('whatsapp.composer.placeholder')}
                            enterKeyHint="send"
                            onChange={(event) => setValue(event.target.value)}
                            onKeyDown={onKeyDown}
                            className="max-h-44 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
                        />
                        <Button
                            type="button"
                            size="icon"
                            data-testid="wa-composer-send"
                            aria-label={t('whatsapp.composer.send')}
                            title={t('whatsapp.composer.send')}
                            disabled={!canSend}
                            onClick={() => void submit()}
                            className="rounded-xl transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none"
                        >
                            <SendHorizontal
                                className="rtl:-scale-x-100"
                                aria-hidden
                            />
                        </Button>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
                        <p className="hidden sm:block [@media(pointer:coarse)]:hidden">
                            {t('whatsapp.composer.hint')}
                        </p>
                        <p
                            id={countId}
                            data-testid="wa-composer-count"
                            className={cn(
                                'ms-auto tabular-nums',
                                nearLimit &&
                                    'font-medium text-amber-700 dark:text-amber-300',
                            )}
                        >
                            {value.length} / {max}
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}
