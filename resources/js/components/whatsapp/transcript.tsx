import { ArrowDown } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { dayLabel } from '@/components/inbox/format';
import { Lightbox } from '@/components/inbox/lightbox';
import { useNow } from '@/components/inbox/use-now';
import { buildWaEntries } from '@/components/whatsapp/format';
import { WaMessageBubble } from '@/components/whatsapp/wa-message-bubble';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import type { DisplayMessage } from '@/lib/whatsapp/transcript';

/** How close to the bottom (px) still counts as "reading the latest": new messages keep the list pinned there. */
const PIN_THRESHOLD = 80;

/**
 * The transcript: day dividers, grouped bubbles and the photo lightbox in a scroll region that is also the `role="log"` live region
 * (new messages are announced politely). It stays pinned to the newest message while the administrator is at the bottom, and offers a
 * "n new messages" button instead of yanking the view when they have scrolled up to read. Older history loads on request.
 */
export function Transcript({
    messages,
    label,
    hasOlder,
    loadingOlder,
    onLoadOlder,
    onRetry,
    onDiscard,
    onImageError,
}: {
    messages: DisplayMessage[];
    label: string;
    hasOlder: boolean;
    loadingOlder: boolean;
    onLoadOlder: () => void;
    onRetry: (clientMsgId: string) => void;
    onDiscard: (clientMsgId: string) => void;
    /** A photo failed to load (its signed URL may have expired): the owner reads the messages again. */
    onImageError?: () => void;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const now = useNow();
    const scroller = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const seen = useRef(new Set(messages.map((message) => message.ulid)));
    const top = useRef(
        messages.reduce((max, m) => (m.ulid > max ? m.ulid : max), ''),
    );
    const [missed, setMissed] = useState(0);
    const [image, setImage] = useState<DisplayMessage | null>(null);
    const entries = useMemo(() => buildWaEntries(messages), [messages]);
    // The lightbox follows the photo's current (possibly refreshed) URL.
    const shown =
        image === null
            ? null
            : (messages.find((message) => message.ulid === image.ulid) ??
              image);

    const toBottom = useCallback(() => {
        const element = scroller.current;

        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, []);

    useLayoutEffect(() => {
        toBottom();
    }, [toBottom]);

    useLayoutEffect(() => {
        const added = messages.filter(
            (message) => !seen.current.has(message.ulid),
        );
        // Only what is NEWER than anything shown before is news: a page of older history added at the top is not.
        const before = top.current;

        for (const message of messages) {
            seen.current.add(message.ulid);

            if (message.ulid > top.current) {
                top.current = message.ulid;
            }
        }

        if (added.length === 0) {
            return;
        }

        const news = added.filter((message) => message.ulid > before);
        const own = news.some((message) => message.local !== undefined);

        if (pinned.current || own) {
            pinned.current = true;
            toBottom();
            // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the counter once the list is pinned again
            setMissed(0);
        } else {
            setMissed(
                (count) =>
                    count +
                    news.filter((message) => message.direction === 'in').length,
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
                data-testid="wa-transcript"
                onScroll={onScroll}
                className="h-full overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
            >
                {hasOlder && (
                    <div className="mb-3 flex justify-center">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={loadingOlder}
                            data-testid="wa-load-older"
                            onClick={() => {
                                // Reading history is not "following the conversation": do not jump back to the bottom.
                                pinned.current = false;
                                onLoadOlder();
                            }}
                        >
                            {loadingOlder && <Busy />}
                            {t('whatsapp.transcript.older')}
                        </Button>
                    </div>
                )}
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
                            <WaMessageBubble
                                key={entry.key}
                                entry={entry}
                                onRetry={onRetry}
                                onDiscard={onDiscard}
                                onOpenImage={setImage}
                                onImageError={onImageError}
                                onImageLoad={() => {
                                    if (pinned.current) {
                                        toBottom();
                                    }
                                }}
                            />
                        ),
                    )}
                </ol>
            </div>

            {missed > 0 && (
                <button
                    type="button"
                    data-testid="wa-messages-jump"
                    onClick={() => {
                        pinned.current = true;
                        setMissed(0);
                        toBottom();
                    }}
                    className="absolute inset-x-0 bottom-3 mx-auto flex w-fit animate-in items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-md duration-200 fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
                >
                    <ArrowDown className="size-3.5" aria-hidden />
                    {plural('whatsapp.transcript.new', missed)}
                </button>
            )}

            <Lightbox
                attachment={
                    shown?.media?.url
                        ? {
                              ulid: shown.ulid,
                              mime: shown.media.mime ?? 'image/jpeg',
                              size: shown.media.size ?? 0,
                              width: null,
                              height: null,
                              url: shown.media.url,
                              thumbUrl: null,
                          }
                        : null
                }
                onClose={() => setImage(null)}
                onError={onImageError}
            />
        </div>
    );
}
