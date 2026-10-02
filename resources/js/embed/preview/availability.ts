import type { PanelAvailability } from '@/embed/config/panel-config';
import { isRecord, type Dict } from '@/embed/protocol/messages';

/**
 * What the preview shows as availability: the draft's hours mode decides (the real presence data does not exist here), and WhatsApp is
 * offered whenever the draft switches the feature on (the hand-off itself is canned: `preview/demo.ts`).
 */
export function previewAvailability(
    config: Dict | null,
    draft: Dict | null,
): PanelAvailability {
    const source = draft ?? config;
    const hours = source !== null && isRecord(source.hours) ? source.hours : {};
    const features =
        source !== null && isRecord(source.features) ? source.features : {};
    const offline = hours.mode === 'always_offline';

    return {
        online: !offline,
        openNow: !offline,
        nextOpenAt: null,
        categories: [],
        whatsapp: { enabled: features.whatsapp === true },
    };
}
