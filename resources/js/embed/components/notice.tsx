import { useSnapshot } from '@/embed/components/context';
import { Banner } from '@/embed/components/ui';
import type { Notice } from '@/embed/state/machine';
import { pluralText, type Translate } from '@/embed/i18n';

export function noticeText(
    notice: Notice,
    t: Translate,
    locale = 'en',
): string {
    switch (notice.code) {
        case 'rate_limited':
            return pluralText(
                t,
                locale,
                'embed.chat.error.rate_limited',
                notice.seconds ?? 5,
            );
        case 'network':
            return t('embed.chat.error.network');
        case 'unavailable':
            return t('embed.chat.error.unavailable');
        case 'session_expired':
            return t('embed.chat.closed.expired');
        case 'identity':
            return t('embed.chat.error.identity');
        case 'feature_disabled':
            return t('embed.chat.error.feature_disabled');
        case 'whatsapp_unavailable':
            return t('embed.chat.whatsapp.unavailable');
        default:
            return t('embed.chat.error.generic');
    }
}

/** The current failure the visitor can act on (cleared by the next action). */
export function NoticeBanner() {
    const { state, config, t } = useSnapshot();

    return state.notice === null ? null : (
        <Banner>{noticeText(state.notice, t, config?.locale)}</Banner>
    );
}
