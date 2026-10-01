import { useState } from 'react';
import { Busy, Notice } from '@/components/widgets/form-bits';
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
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetListItemData } from '@/types/widgets';

export function DeleteWidgetDialog({
    widget,
    onClose,
    onDeleted,
}: {
    widget: WidgetListItemData | null;
    onClose: () => void;
    onDeleted: (ulid: string) => void;
}) {
    const { t } = useTrans();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function confirm() {
        if (!widget) {
            return;
        }

        setPending(true);
        setError(null);

        try {
            await api.delete(widgetsRoutes.api.widgets.show(widget.ulid));
            onDeleted(widget.ulid);
        } catch (failure) {
            setError(describeApiError(failure, t));
        } finally {
            setPending(false);
        }
    }

    return (
        <AlertDialog
            open={widget !== null}
            onOpenChange={(open) => {
                if (!open) {
                    setError(null);
                    onClose();
                }
            }}
        >
            <AlertDialogContent data-testid="widget-delete-dialog">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t('widgets.delete.title', {
                            name: widget?.name ?? '',
                        })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('widgets.delete.body')}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error && <Notice tone="danger">{error}</Notice>}
                <AlertDialogFooter>
                    <AlertDialogCancel>
                        {t('widgets.delete.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={pending}
                        data-testid="widget-delete-confirm"
                        onClick={(event) => {
                            event.preventDefault();
                            void confirm();
                        }}
                    >
                        {pending && <Busy />}
                        {t('widgets.delete.confirm')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
