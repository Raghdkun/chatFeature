import { useSnapshot } from '@/embed/components/context';
import { MessageCircle } from '@/embed/components/icons';

/**
 * Slot of the WhatsApp channel chooser (P6). It renders only when the widget offers WhatsApp (`availability.whatsapp.enabled` and
 * `features.whatsapp`, which `buildPanelConfig` already combined); until P6 wires the hand-off it is a labelled placeholder.
 */
export function ChannelChooser() {
    const { config, t } = useSnapshot();

    if (config === null || !config.features.whatsapp) {
        return null;
    }

    return (
        <div
            data-testid="channel-chooser"
            role="group"
            aria-label={t('embed.chat.whatsapp.title')}
            className="border-line flex items-center gap-3 rounded-md border bg-muted px-3 py-2.5 text-[14px] font-semibold"
        >
            <MessageCircle aria-hidden="true" className="size-5" />
            {t('embed.chat.whatsapp.title')}
        </div>
    );
}
