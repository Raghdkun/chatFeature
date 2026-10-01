import type { PanelAvailability } from '@/embed/config/panel-config';
import { isRecord, type Dict } from '@/embed/protocol/messages';

/** What the preview shows as availability: the draft's hours mode decides (the real presence data does not exist here). */
export function previewAvailability(
    config: Dict | null,
    draft: Dict | null,
): PanelAvailability {
    const source = draft ?? config;
    const hours = source !== null && isRecord(source.hours) ? source.hours : {};
    const offline = hours.mode === 'always_offline';

    return {
        online: !offline,
        openNow: !offline,
        nextOpenAt: null,
        categories: [],
        whatsapp: { enabled: false },
    };
}
