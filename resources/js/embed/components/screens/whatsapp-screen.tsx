import { useRef, useState } from 'react';
import { useController, useEnv, useSnapshot } from '@/embed/components/context';
import { Check, Copy, ExternalLink } from '@/embed/components/icons';
import { NoticeBanner } from '@/embed/components/notice';
import { Button } from '@/embed/components/ui';
import { useClock } from '@/embed/hooks/use-clock';
import {
    formatRemaining,
    remainingMs,
    spacedCode,
    whatsAppHref,
} from '@/embed/lib/whatsapp';

type Copied = 'idle' | 'ok' | 'failed';

/**
 * `whatsapp`: the hand-off. The code in big type (with a copy button), "Open WhatsApp" (the `wa.me` link, a new tab, only when it really
 * is a WhatsApp link), how long the code still works (a new one when it ran out), and "I sent it", which says that the reply comes on
 * WhatsApp. The code is plain text the visitor can select, so a failed copy never leaves them stuck.
 */
export function WhatsAppScreen() {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const env = useEnv();
    const now = useClock();
    const [copied, setCopied] = useState<Copied>('idle');
    const code = useRef<HTMLParagraphElement>(null);
    const handoff = state.whatsapp.handoff;

    if (handoff === null || config === null) {
        return null;
    }

    const left = remainingMs(handoff.expiresAt, now);
    const expired = left !== null && left <= 0;
    const href = whatsAppHref(handoff.waUrl);
    const busy = state.busy === 'whatsapp';

    const copy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(handoff.code);
            setCopied('ok');
        } catch {
            // No clipboard (an insecure page, a blocked permission): select the code so Ctrl+C works.
            const element = code.current;

            if (element !== null) {
                const range = document.createRange();

                range.selectNodeContents(element);
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(range);
            }

            setCopied('failed');
        }
    };

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
            <div className="flex flex-col gap-1.5">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[20px] leading-snug font-semibold outline-none"
                >
                    {t('embed.chat.whatsapp.heading')}
                </h2>
                <p className="text-subtle">{t('embed.chat.whatsapp.intro')}</p>
            </div>

            <NoticeBanner />

            <div className="border-line flex flex-col items-center gap-1 rounded-md border bg-muted px-4 py-5 text-center">
                <p className="text-subtle text-[13px] font-medium">
                    {t('embed.chat.whatsapp.code_label')}
                </p>
                <p
                    ref={code}
                    dir="ltr"
                    data-testid="whatsapp-code"
                    aria-label={`${t('embed.chat.whatsapp.code_label')}: ${handoff.code.split('').join(' ')}`}
                    className={`text-[32px] leading-tight font-semibold tracking-[0.12em] [overflow-wrap:anywhere] tabular-nums select-all ${expired ? 'text-subtle line-through' : ''}`}
                >
                    {spacedCode(handoff.code)}
                </p>
                {expired ? (
                    <p
                        role="status"
                        data-testid="whatsapp-expiry"
                        data-expired="true"
                        className="text-danger text-[13px]"
                    >
                        {t('embed.chat.whatsapp.expired')}
                    </p>
                ) : left !== null ? (
                    <p
                        data-testid="whatsapp-expiry"
                        className="text-subtle text-[13px]"
                    >
                        {t('embed.chat.whatsapp.expires', {
                            time: formatRemaining(left, config.locale),
                        })}
                    </p>
                ) : null}
            </div>

            {expired ? (
                <Button
                    data-testid="whatsapp-new-code"
                    data-autofocus
                    block
                    busy={busy}
                    onClick={() => controller.newWhatsAppCode()}
                >
                    {t('embed.chat.whatsapp.new_code')}
                </Button>
            ) : (
                <div className="flex flex-col gap-2.5">
                    {href !== null && !env.preview ? (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="whatsapp-open"
                            data-autofocus
                            className="pne-press pne-focus bg-brand text-on-brand pne-hover-fill inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-[15px] font-semibold"
                        >
                            <ExternalLink
                                aria-hidden="true"
                                className="size-4 rtl:-scale-x-100"
                            />
                            {t('embed.chat.whatsapp.open')}
                        </a>
                    ) : (
                        // The builder preview never opens a real chat; a link that is not WhatsApp's is never opened at all.
                        <Button
                            data-testid="whatsapp-open"
                            data-autofocus
                            block
                            aria-disabled="true"
                            onClick={(event) => event.preventDefault()}
                        >
                            <ExternalLink
                                aria-hidden="true"
                                className="size-4 rtl:-scale-x-100"
                            />
                            {t('embed.chat.whatsapp.open')}
                        </Button>
                    )}
                    <p className="text-subtle text-center text-[13px]">
                        {t('embed.chat.whatsapp.open_hint')}
                    </p>
                    <Button
                        variant="quiet"
                        data-testid="whatsapp-copy"
                        block
                        onClick={() => void copy()}
                    >
                        {copied === 'ok' ? (
                            <Check aria-hidden="true" className="size-4" />
                        ) : (
                            <Copy aria-hidden="true" className="size-4" />
                        )}
                        <span aria-live="polite">
                            {copied === 'ok'
                                ? t('embed.chat.whatsapp.copied')
                                : t('embed.chat.whatsapp.copy')}
                        </span>
                    </Button>
                    {copied === 'failed' ? (
                        <p
                            role="status"
                            className="text-subtle text-center text-[13px]"
                        >
                            {t('embed.chat.whatsapp.copy_failed')}
                        </p>
                    ) : null}
                    <Button
                        variant="quiet"
                        data-testid="whatsapp-sent"
                        block
                        onClick={() => controller.whatsAppSent()}
                    >
                        {t('embed.chat.whatsapp.sent')}
                    </Button>
                </div>
            )}

            <Button
                variant="ghost"
                className="self-start"
                data-testid="whatsapp-back"
                disabled={busy}
                onClick={() => controller.back()}
            >
                {t('embed.chat.back')}
            </Button>
        </section>
    );
}
