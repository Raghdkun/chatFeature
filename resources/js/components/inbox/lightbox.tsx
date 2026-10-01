import { ExternalLink } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { useTrans } from '@/hooks/use-trans';
import { safeExternalUrl } from '@/lib/urls';
import type { AttachmentData } from '@/lib/chat/types';

/** The full-size image of an attachment in a dialog (Escape or the close button return focus to the thumbnail that opened it). */
export function Lightbox({
    attachment,
    onClose,
    onError,
}: {
    attachment: AttachmentData | null;
    onClose: () => void;
    /** The picture failed to load (an expired signed URL): the owner fetches fresh URLs and passes the new attachment in. */
    onError?: () => void;
}) {
    const { t } = useTrans();
    const href = safeExternalUrl(attachment?.url);
    const returnFocus = useReturnFocus(attachment !== null);

    return (
        <Dialog
            open={attachment !== null}
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
        >
            <DialogContent
                data-testid="lightbox"
                {...returnFocus}
                className="w-fit max-w-[min(95vw,64rem)] gap-3 p-3 sm:max-w-[min(95vw,64rem)]"
            >
                <DialogTitle className="sr-only">
                    {t('inbox.lightbox.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                    {t('inbox.lightbox.description')}
                </DialogDescription>
                {attachment && (
                    <img
                        src={attachment.url}
                        alt={t('inbox.message.image_alt')}
                        onError={onError}
                        className="mx-auto max-h-[75dvh] w-auto max-w-full rounded-md object-contain"
                    />
                )}
                {href && (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                        <ExternalLink className="size-3.5" aria-hidden />
                        {t('inbox.lightbox.open')}
                    </a>
                )}
            </DialogContent>
        </Dialog>
    );
}
