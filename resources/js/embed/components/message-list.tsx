import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { MessageBubble } from '@/embed/components/message-bubble';
import {
    TypingIndicator,
    TypingStatus,
} from '@/embed/components/typing-indicator';
import { formatDay } from '@/embed/lib/format';
import { layoutMessages } from '@/embed/lib/group';
import { useDocumentVisible, useReducedMotion } from '@/embed/hooks/use-media';
import type { AttachmentData } from '@/lib/chat/types';

const NEAR_BOTTOM_PX = 64;

type Props = {
    onOpenImage: (attachment: AttachmentData, alt: string) => void;
};

/**
 * The conversation: `role="log"` with a polite live region, date separators, grouped bubbles, receipts, the typing indicator,
 * scroll anchoring (stick to the end while the visitor is there, a "New messages" pill when they scrolled up) and the
 * "the visitor is looking at the newest messages" signal that drives seen receipts.
 */
export function MessageList({ onOpenImage }: Props) {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const visible = useDocumentVisible();
    const reduced = useReducedMotion();
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const first = useRef(true);
    const [atBottom, setAtBottom] = useState(true);
    const [seenCount, setSeenCount] = useState(0);
    const [known] = useState(
        () => new Set(state.messages.map((m) => m.clientMsgId ?? m.ulid ?? '')),
    );
    const items = layoutMessages(state.messages);
    const locale = config?.locale ?? 'en';
    const total = state.messages.length;
    const agent = state.conversation?.agent ?? null;
    const lastVisitor = [...state.messages]
        .reverse()
        .find((message) => message.sender.type === 'visitor');

    const scrollToEnd = (smooth: boolean): void => {
        const element = scroller.current;

        if (element === null) {
            return;
        }

        if (smooth && !reduced && typeof element.scrollTo === 'function') {
            element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
        } else {
            element.scrollTop = element.scrollHeight;
        }
    };

    useLayoutEffect(() => {
        const last = state.messages.at(-1);

        if (first.current) {
            first.current = false;
            scrollToEnd(false);
            setSeenCount(total);

            return;
        }

        if (stick.current || last?.sender.type === 'visitor') {
            scrollToEnd(true);
            setSeenCount(total);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [total, state.typing]);

    useEffect(() => {
        controller.setViewing(state.open && visible && atBottom);

        return () => controller.setViewing(false);
    }, [controller, state.open, visible, atBottom]);

    const onScroll = (): void => {
        const element = scroller.current;

        if (element === null) {
            return;
        }

        const near =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            NEAR_BOTTOM_PX;

        stick.current = near;
        setAtBottom(near);

        if (near) {
            setSeenCount(total);
        }
    };

    const below = Math.max(0, total - seenCount);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scroller}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label={t('embed.chat.active.log_label')}
                tabIndex={0}
                data-testid="message-list"
                onScroll={onScroll}
                className="pne-focus min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
            >
                {items.map((item) => {
                    if (item.kind === 'separator') {
                        return (
                            <div
                                key={item.key}
                                className="text-subtle my-3 flex justify-center text-[12px] font-medium"
                            >
                                <time
                                    dateTime={item.at}
                                    className="rounded-full bg-muted px-3 py-0.5"
                                >
                                    {formatDay(item.at, locale, Date.now())}
                                </time>
                            </div>
                        );
                    }

                    if (item.kind === 'system') {
                        return (
                            <p
                                key={item.key}
                                data-testid={`message-${item.message.ulid ?? 'system'}`}
                                data-status={item.message.status}
                                data-sender="system"
                                className="text-subtle my-2 text-center text-[13px]"
                            >
                                {item.message.body}
                            </p>
                        );
                    }

                    return (
                        <MessageBubble
                            key={item.key}
                            message={item.message}
                            t={t}
                            locale={locale}
                            groupStart={item.groupStart}
                            groupEnd={item.groupEnd}
                            isNew={!known.has(item.key)}
                            showStatusText={item.message === lastVisitor}
                            onRetry={(id) => controller.retry(id)}
                            onDiscard={(id) => controller.discard(id)}
                            onOpenImage={onOpenImage}
                            onImageLoad={() => {
                                // A picture that finished loading made the list taller: stay pinned to the end.
                                if (stick.current) {
                                    scrollToEnd(false);
                                }
                            }}
                            onImageError={() =>
                                void controller.refreshAttachmentUrls()
                            }
                        />
                    );
                })}
                <TypingIndicator
                    typing={state.typing}
                    name={agent?.name ?? t('embed.chat.active.agent_fallback')}
                    avatarUrl={agent?.avatarUrl ?? null}
                />
            </div>
            <TypingStatus
                typing={state.typing}
                name={agent?.name ?? t('embed.chat.active.agent_fallback')}
                t={t}
            />
            {!atBottom && below > 0 ? (
                <button
                    type="button"
                    data-testid="new-messages-pill"
                    onClick={() => {
                        scrollToEnd(true);
                        setSeenCount(total);
                    }}
                    className="pne-press pne-focus bg-brand text-on-brand pne-hover-fill absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full px-4 py-1.5 text-[13px] font-semibold shadow-md"
                >
                    {t('embed.chat.active.new_messages')} ({below})
                </button>
            ) : null}
        </div>
    );
}
