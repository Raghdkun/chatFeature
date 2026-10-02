import { useController, useSnapshot } from '@/embed/components/context';
import { MessageCircle } from '@/embed/components/icons';

const CARD =
    'pne-press pne-focus flex w-full items-center gap-3 rounded-md p-3.5 text-start disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The channel choice (P6): "Chat here" (the built-in chat, the old start) or "Continue on WhatsApp" (a hand-off code and a link). It
 * renders only when the widget offers WhatsApp (`availability.whatsapp.enabled` and `features.whatsapp`, which `buildPanelConfig`
 * already combined). On the welcome screen it takes the place of the single start button; on the offline screen (nobody can answer) it
 * is only the WhatsApp alternative.
 */
export function ChannelChooser({
    variant = 'welcome',
}: {
    variant?: 'welcome' | 'offline';
}) {
    const { state, config, t } = useSnapshot();
    const controller = useController();

    if (config === null || !config.features.whatsapp) {
        return null;
    }

    const busy = state.busy !== null;
    const starting = state.busy === 'starting';
    const handing = state.busy === 'whatsapp';
    const whatsapp = (
        <button
            type="button"
            data-testid="channel-whatsapp"
            disabled={busy}
            aria-busy={handing || undefined}
            onClick={() => controller.startWhatsApp()}
            className={`${CARD} border-line bg-surface pne-hover-lift border`}
        >
            <span
                aria-hidden="true"
                className="bg-brand-soft text-brand grid size-10 shrink-0 place-items-center rounded-full"
            >
                {handing ? (
                    <span className="pne-spinner" />
                ) : (
                    <MessageCircle className="size-5" />
                )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold">
                    {t('embed.chat.whatsapp.title')}
                </span>
                <span className="text-subtle text-[13px] leading-snug">
                    {t('embed.chat.whatsapp.choose_whatsapp_hint')}
                </span>
            </span>
        </button>
    );

    if (variant === 'offline') {
        return (
            <div
                data-testid="channel-chooser"
                role="group"
                aria-label={t('embed.chat.whatsapp.chooser_label')}
                className="flex flex-col gap-2.5"
            >
                <p className="text-subtle text-[13px]">
                    {t('embed.chat.whatsapp.offline_option')}
                </p>
                {whatsapp}
            </div>
        );
    }

    return (
        <div
            data-testid="channel-chooser"
            role="group"
            aria-label={t('embed.chat.whatsapp.chooser_label')}
            className="flex flex-col gap-2.5"
        >
            <button
                type="button"
                data-testid="channel-chat"
                data-autofocus
                disabled={busy}
                aria-busy={starting || undefined}
                onClick={() => controller.start()}
                className={`${CARD} bg-brand text-on-brand pne-hover-fill`}
            >
                <span
                    aria-hidden="true"
                    className="bg-on-brand/15 grid size-10 shrink-0 place-items-center rounded-full"
                >
                    {starting ? (
                        <span className="pne-spinner" />
                    ) : (
                        <MessageCircle className="size-5" />
                    )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold">
                        {t('embed.chat.whatsapp.choose_chat')}
                    </span>
                    <span className="text-[13px] leading-snug opacity-85">
                        {t('embed.chat.whatsapp.choose_chat_hint')}
                    </span>
                </span>
            </button>
            {whatsapp}
        </div>
    );
}
