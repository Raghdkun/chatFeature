import { useState } from 'react';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';

/**
 * Confirm ending a live chat (the visitor is asked to rate it) or closing an offline ticket (answered, no rating). Ending is
 * irreversible for the visitor, so it is never one click.
 */
export function EndChatDialog({
    open,
    mode,
    onOpenChange,
    onConfirm,
}: {
    open: boolean;
    mode: 'end' | 'close';
    onOpenChange: (open: boolean) => void;
    /** Resolves `true` when the server accepted (the dialog closes), `false` to stay open. */
    onConfirm: () => Promise<boolean>;
}) {
    const { t } = useTrans();
    const [pending, setPending] = useState(false);
    const returnFocus = useReturnFocus(open);

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent data-testid="end-chat-dialog" {...returnFocus}>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t(`inbox.${mode}.title`)}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t(`inbox.${mode}.body`)}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{t('inbox.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={pending}
                        data-testid="end-chat-confirm"
                        onClick={(event) => {
                            event.preventDefault();
                            setPending(true);
                            void onConfirm()
                                .then((done) => {
                                    if (done) {
                                        onOpenChange(false);
                                    }
                                })
                                .finally(() => setPending(false));
                        }}
                    >
                        {pending && <Busy />}
                        {t(`inbox.${mode}.confirm`)}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
