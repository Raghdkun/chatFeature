import { Avatar } from '@/embed/components/ui';
import type { Translate } from '@/embed/i18n';

/**
 * The agent's three dots (decorative: hidden from assistive technology, the status below speaks for them). Rendered inside the
 * scrolling list so they sit where the next bubble will appear.
 */
export function TypingIndicator({
    typing,
    name,
    avatarUrl,
}: {
    typing: boolean;
    name: string;
    avatarUrl: string | null;
}) {
    return typing ? (
        <div
            data-testid="typing-indicator"
            aria-hidden="true"
            className="pne-msg-new mt-3 flex items-end gap-2"
        >
            <Avatar name={name} url={avatarUrl} size={32} />
            <span className="text-subtle inline-flex items-center gap-1 rounded-lg rounded-es-sm bg-muted px-3.5 py-3">
                <span className="pne-dot" />
                <span className="pne-dot" />
                <span className="pne-dot" />
            </span>
        </div>
    ) : null;
}

/**
 * "Sam is typing…" for screen readers. A polite live region that is always mounted (a region that appears together with its text is
 * often not announced), and deliberately OUTSIDE the message log so the log announces messages only.
 */
export function TypingStatus({
    typing,
    name,
    t,
}: {
    typing: boolean;
    name: string;
    t: Translate;
}) {
    return (
        <div role="status" className="sr-only">
            {typing ? t('embed.chat.active.typing', { name }) : ''}
        </div>
    );
}
