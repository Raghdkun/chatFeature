import { router } from '@inertiajs/react';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, type ReactNode } from 'react';
import { ChatList } from '@/components/inbox/chat-list';
import { ConnectionBanner } from '@/components/inbox/connection-banner';
import { RosterPopover, SoundToggle } from '@/components/inbox/inbox-toolbar';
import { PresenceSelect } from '@/components/inbox/presence-select';
import { QueueSection } from '@/components/inbox/queue-section';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import {
    useInbox,
    useStaffRealtimeContext,
} from '@/lib/realtime/staff/context';
import { ServingNotice } from '@/components/dashboard/serving-notice';
import type { InboxShellProps } from '@/types/chat-staff';
import { cn } from '@/lib/utils';

/**
 * The two-pane inbox: the list column (presence, queue, my chats) and the conversation. From `md` up both are visible; below it the
 * list and the conversation are separate screens (the list is `/inbox`, a conversation is `/inbox/{ulid}` with a back arrow).
 * The lists are read from the live store, which the server props seed on arrival (so a reload and a visit start from the truth).
 */
export function InboxShell({
    queue,
    mine,
    presence,
    serving,
    selectedUlid,
    children,
}: InboxShellProps & {
    selectedUlid: string | null;
    /** The conversation view; absent on `/inbox`. */
    children?: ReactNode;
}) {
    const { t } = useTrans();
    const { store, controller, sound, viewer } = useStaffRealtimeContext();
    const live = useInbox((state) => state);
    const Title = selectedUlid ? 'h2' : 'h1';
    const presenceId = useId();

    // Seed the live lists from the props before the first paint (no flash of an empty inbox).
    useLayoutEffect(() => {
        store.dispatch({ type: 'hydrate', queue, mine });
    }, [store, queue, mine]);

    useLayoutEffect(() => {
        store.dispatch({ type: 'presence', status: presence.status });
    }, [store, presence.status]);

    // The props can be older than the store (the browser's Back button restores a page as it was): look again, in the background.
    useEffect(() => {
        void controller.sync();
    }, [controller]);

    const accept = async (ulid: string): Promise<void> => {
        const outcome = await controller.claim(ulid);

        if (outcome.ok) {
            router.visit(staffRoutes.pages.conversation(ulid));
        }
    };

    return (
        <div
            data-testid="inbox"
            className="flex h-[calc(100dvh-4rem)] min-h-0 overflow-hidden md:h-[calc(100dvh-5rem)] md:rounded-xl md:border md:bg-card"
        >
            {/* A region, not an `aside`: it sits inside the page's own <main>, where a complementary landmark is not allowed. */}
            <section
                aria-label={t('inbox.list.label')}
                className={cn(
                    'min-h-0 w-full shrink-0 flex-col border-e bg-background md:flex md:w-80 lg:w-[22rem]',
                    selectedUlid ? 'hidden' : 'flex',
                )}
            >
                <div className="flex items-center gap-2 border-b px-3 py-2.5">
                    <Title className="flex-1 text-base font-semibold tracking-tight">
                        {t('inbox.title')}
                    </Title>
                    <RosterPopover roster={live.roster} viewerId={viewer.id} />
                    <SoundToggle sound={sound} />
                </div>

                <ConnectionBanner status={live.connection} />

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {viewer.isAgent && (
                        <div className="grid grid-cols-1 gap-2 px-3 pt-3">
                            <label
                                htmlFor={presenceId}
                                className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                            >
                                {t('inbox.presence.label')}
                            </label>
                            <PresenceSelect
                                id={presenceId}
                                status={live.presence}
                                onChange={(status) =>
                                    void controller.setPresence(status)
                                }
                            />
                            <ServingNotice serving={serving} />
                            {live.presence === 'offline' && (
                                <Notice
                                    tone="warning"
                                    data-testid="presence-offline-notice"
                                    className="text-xs"
                                >
                                    <p>{t('inbox.presence.offline_notice')}</p>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="mt-2 bg-background"
                                        data-testid="presence-go-online"
                                        onClick={() =>
                                            void controller.setPresence(
                                                'online',
                                            )
                                        }
                                    >
                                        {t('inbox.presence.go_online')}
                                    </Button>
                                </Notice>
                            )}
                        </div>
                    )}

                    <QueueSection
                        items={live.queue}
                        canAccept={viewer.isAgent}
                        onAccept={accept}
                    />
                    <ChatList
                        chats={live.mine}
                        selected={selectedUlid}
                        viewerId={viewer.id}
                    />
                </div>
            </section>

            <div
                className={cn(
                    'min-w-0 flex-1 flex-col',
                    selectedUlid ? 'flex' : 'hidden md:flex',
                )}
            >
                {selectedUlid && (
                    <ConnectionBanner
                        status={live.connection}
                        variant="conversation"
                    />
                )}
                {children ?? (
                    <Empty
                        data-testid="inbox-empty-conversation"
                        className="border-0"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <MessagesSquare aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>
                                {t('inbox.conversation.empty_title')}
                            </EmptyTitle>
                            <EmptyDescription>
                                {t('inbox.conversation.empty_body')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )}
            </div>
        </div>
    );
}
