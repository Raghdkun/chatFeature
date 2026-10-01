import type { ConversationStaff } from '@/lib/chat/types';
import { safeExternalUrl } from '@/lib/urls';

/** The keys the host page's identity / metadata may use for the page the visitor is on. */
export const PAGE_URL_KEYS = ['page_url', 'pageUrl', 'url', 'page'];

/** The page the visitor was on, when the host site sent one in the visitor metadata (and it is a plain web link). */
export function visitorPageUrl(
    meta: ConversationStaff['visitor']['meta'],
): string | null {
    for (const key of PAGE_URL_KEYS) {
        const value = meta[key];

        if (typeof value === 'string') {
            const safe = safeExternalUrl(value);

            if (safe) {
                return safe;
            }
        }
    }

    return null;
}

/** "shop.example/pricing": a page address short enough for a header line. */
export function shortPageLabel(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname === '/' ? '' : parsed.pathname;

        return `${parsed.host}${path}`;
    } catch {
        return url;
    }
}
