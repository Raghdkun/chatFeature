import { Avatar } from '@/embed/components/ui';
import type { Translate } from '@/embed/i18n';

/**
 * The agent's three dots. A polite live region that is always mounted announces "Sam is typing…" to screen readers (a region that
 * appears together with its text is often not announced); the visible dots exist only while the agent types.
 */
export function TypingIndicator({
    typing,
    name,
    avatarUrl,
    t,
}: {
    typing: boolean;
    name: string;
    avatarUrl: string | null;
    t: Translate;
}) {
    return (
        <>
            <div role="status" className="sr-only">
                {typing ? t('embed.chat.active.typing', { name }) : ''}
            </div>
            {typing ? (
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
            ) : null}
        </>
    );
}
