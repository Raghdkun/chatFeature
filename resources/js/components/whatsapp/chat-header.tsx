import { Link } from '@inertiajs/react';
import { Archive, ArchiveRestore, ArrowLeft, Info, Link2 } from 'lucide-react';
import { ChatAvatar } from '@/components/whatsapp/chat-avatar';
import { chatTitle } from '@/components/whatsapp/format';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaChat } from '@/lib/whatsapp/types';

/** Who this is, which session they wrote to, what links them to the website, and what the administrator can do with the chat. */
export function ChatHeader({
    chat,
    archiving,
    onDetails,
    onToggleArchive,
}: {
    chat: WaChat;
    archiving: boolean;
    onDetails: () => void;
    onToggleArchive: () => void;
}) {
    const { t } = useTrans();
    const title = chatTitle(chat, t('whatsapp.chat.unknown'));
    const archived = chat.status === 'archived';
    const link = [chat.widget?.name, chat.category?.label].filter(Boolean);
    const subline = [chat.phone, chat.session.name].filter(Boolean);

    return (
        <header
            data-testid="wa-chat-header"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-2.5 sm:px-4"
        >
            <Button asChild variant="ghost" size="icon" className="md:hidden">
                <Link
                    href={waRoutes.pages.inbox()}
                    data-testid="wa-chat-back"
                    aria-label={t('whatsapp.back')}
                >
                    <ArrowLeft className="rtl:-scale-x-100" aria-hidden />
                </Link>
            </Button>

            <ChatAvatar title={title} />

            <div className="min-w-32 flex-1">
                <h1
                    dir="auto"
                    data-testid="wa-chat-name"
                    className="truncate text-sm font-semibold sm:text-base"
                >
                    {title}
                </h1>
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span dir="ltr">{subline.join(' · ')}</span>
                    {link.length > 0 ? (
                        <span
                            data-testid="wa-chat-linked"
                            className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-px text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100"
                        >
                            <Link2 className="size-3" aria-hidden />
                            {link.join(' · ')}
                        </span>
                    ) : (
                        <span className="rounded bg-muted px-1.5 py-px">
                            {t('whatsapp.chat.unlinked')}
                        </span>
                    )}
                </p>
            </div>

            <div className="ms-auto flex items-center gap-0.5">
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="wa-chat-info"
                    aria-label={t('whatsapp.details.open')}
                    title={t('whatsapp.details.open')}
                    onClick={onDetails}
                >
                    <Info aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="ms-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:w-auto sm:px-3"
                    data-testid="wa-archive"
                    aria-label={t(
                        archived ? 'whatsapp.unarchive' : 'whatsapp.archive',
                    )}
                    title={t(
                        archived ? 'whatsapp.unarchive' : 'whatsapp.archive',
                    )}
                    // Not `disabled`: a disabled button drops the keyboard focus to the page, and the next Enter goes nowhere.
                    aria-disabled={archiving || undefined}
                    onClick={archiving ? undefined : onToggleArchive}
                >
                    {archiving ? (
                        <Busy />
                    ) : archived ? (
                        <ArchiveRestore aria-hidden />
                    ) : (
                        <Archive aria-hidden />
                    )}
                    <span className="hidden sm:inline">
                        {t(
                            archived
                                ? 'whatsapp.unarchive'
                                : 'whatsapp.archive',
                        )}
                    </span>
                </Button>
            </div>
        </header>
    );
}
