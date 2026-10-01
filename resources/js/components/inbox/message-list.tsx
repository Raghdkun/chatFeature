import { ArrowDown } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { buildListEntries, dayLabel } from '@/components/inbox/format';
import { Lightbox } from '@/components/inbox/lightbox';
import { MessageBubble } from '@/components/inbox/message-bubble';
import { TypingIndicator } from '@/components/inbox/typing-indicator';
import { useNow } from '@/components/inbox/use-now';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import type { AttachmentData, LocalMessage } from '@/lib/chat/types';

/** How close to the bottom (px) still counts as "reading the latest": new messages keep the list pinned there. */
const PIN_THRESHOLD = 80;

/**
 * The transcript: day dividers, grouped bubbles, ticks, image lightbox and the typing indicator, in a scroll region that is also the
 * `role="log"` live region (new messages are announced politely). It stays pinned to the newest message while the agent is at the
 * bottom, and shows a "n new messages" button instead of yanking the view when they have scrolled up to read.
 */
export function MessageList({
    messages,
    typing,
    visitorName,
    label,
    onRetry,
    onDiscard,
}: {
    messages: LocalMessage[];
    typing: boolean;
    visitorName: string;
    label: string;
    onRetry: (clientMsgId: string) => void;
    onDiscard: (clientMsgId: string) => void;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const now = useNow();
    const scroller = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const seen = useRef(messages.length);
    const [missed, setMissed] = useState(0);
    const [image, setImage] = useState<AttachmentData | null>(null);
    const entries = useMemo(() => buildListEntries(messages), [messages]);

    const toBottom = useCallback(() => {
        const element = scroller.current;

        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, []);

    // First paint: start at the newest message.
    useLayoutEffect(() => {
        toBottom();
    }, [toBottom]);

    useLayoutEffect(() => {
        const added = messages.slice(seen.current);

        seen.current = messages.length;

        if (added.length === 0) {
            return;
        }

        const own = added.some(
            (message) =>
                message.sender.type === 'agent' && message.seq === null,
        );

        if (pinned.current || own) {
            pinned.current = true;
            toBottom();
            // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the counter once the list is pinned again
            setMissed(0);
        } else {
            setMissed(
                (count) =>
                    count +
                    added.filter((message) => message.sender.type !== 'system')
                        .length,
            );
        }
    }, [messages, toBottom]);

    // The composer growing shrinks this region: keep the newest message in view.
    useEffect(() => {
        const element = scroller.current;

        if (!element || typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(() => {
            if (pinned.current) {
                toBottom();
            }
        });

        observer.observe(element);

        return () => observer.disconnect();
    }, [toBottom]);

    const onScroll = (): void => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            PIN_THRESHOLD;

        if (pinned.current && missed > 0) {
            setMissed(0);
        }
    };

    return (
        <div className="relative min-h-0 flex-1">
            <div
                ref={scroller}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label={label}
                tabIndex={0}
                data-testid="message-list"
                onScroll={onScroll}
                className="h-full overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
            >
                <ol className="flex flex-col">
                    {entries.map((entry) =>
                        entry.kind === 'day' ? (
                            <li
                                key={entry.key}
                                aria-label={dayLabel(entry.iso, now, locale, t)}
                                className="my-3 flex items-center gap-3 text-xs text-muted-foreground first:mt-0"
                            >
                                <span
                                    aria-hidden
                                    className="h-px flex-1 bg-border"
                                />
                                <span>
                                    {dayLabel(entry.iso, now, locale, t)}
                                </span>
                                <span
                                    aria-hidden
                                    className="h-px flex-1 bg-border"
                                />
                            </li>
                        ) : (
                            <MessageBubble
                                key={entry.key}
                                entry={entry}
                                onRetry={onRetry}
                                onDiscard={onDiscard}
                                onOpenImage={setImage}
                                onImageLoad={() => {
                                    if (pinned.current) {
                                        toBottom();
                                    }
                                }}
                            />
                        ),
                    )}
                </ol>
                {typing && <TypingIndicator name={visitorName} />}
            </div>

            {missed > 0 && (
                <button
                    type="button"
                    data-testid="messages-jump"
                    onClick={() => {
                        pinned.current = true;
                        setMissed(0);
                        toBottom();
                    }}
                    className="absolute inset-x-0 bottom-3 mx-auto flex w-fit animate-in items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-md duration-200 fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
                >
                    <ArrowDown className="size-3.5" aria-hidden />
                    {plural('inbox.messages.new', missed)}
                </button>
            )}

            <Lightbox attachment={image} onClose={() => setImage(null)} />
        </div>
    );
}
