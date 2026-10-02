import { useState, type ReactNode } from 'react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { Busy, Notice } from '@/components/widgets/form-bits';

/**
 * A confirmation before something that cannot be undone from this page (stop, delete). The action's own failure is shown inside the
 * dialog (not in a toast behind it), and the dialog stays open so it can be tried again. `extra` is for a second, more drastic choice
 * the failure may open (delete here even though OpenWA could not be asked).
 */
export function ConfirmDialog({
    open,
    title,
    body,
    confirm,
    cancel,
    destructive = false,
    testId,
    onConfirm,
    onClose,
    error,
    extra,
}: {
    open: boolean;
    title: string;
    body: ReactNode;
    confirm: string;
    cancel: string;
    destructive?: boolean;
    testId: string;
    /** Resolve to run the action; throw to show `error(thrown)` inside the dialog. */
    onConfirm: () => Promise<void>;
    onClose: () => void;
    /** What to say about a failure; `null` = nothing to add (the dialog closes only on success). */
    error: (failure: unknown) => string;
    extra?: (failure: unknown) => ReactNode;
}) {
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<unknown>(null);
    const returnFocus = useReturnFocus(open);

    const run = async (): Promise<void> => {
        setPending(true);
        setFailure(null);

        try {
            await onConfirm();
        } catch (caught) {
            setFailure(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setFailure(null);
                    onClose();
                }
            }}
        >
            <AlertDialogContent data-testid={testId} {...returnFocus}>
                <AlertDialogHeader>
                    <AlertDialogTitle className="[overflow-wrap:anywhere]">
                        {title}
                    </AlertDialogTitle>
                    <AlertDialogDescription>{body}</AlertDialogDescription>
                </AlertDialogHeader>
                {failure !== null && (
                    <Notice tone="danger" data-testid={`${testId}-error`}>
                        {error(failure)}
                    </Notice>
                )}
                {failure !== null && extra?.(failure)}
                <AlertDialogFooter>
                    <AlertDialogCancel>{cancel}</AlertDialogCancel>
                    <AlertDialogAction
                        variant={destructive ? 'destructive' : 'default'}
                        disabled={pending}
                        data-testid={`${testId}-confirm`}
                        onClick={(event) => {
                            event.preventDefault();
                            void run();
                        }}
                    >
                        {pending && <Busy />}
                        {confirm}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
