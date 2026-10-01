import { useState } from 'react';
import { Busy, Notice } from '@/components/widgets/form-bits';
import { usePlural } from '@/components/widgets/page-chrome';
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
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { CategoryData } from '@/types/widgets';

export function CategoryDeleteDialog({
    category,
    onClose,
    onDeleted,
    onDeactivate,
}: {
    category: CategoryData | null;
    onClose: () => void;
    onDeleted: (ulid: string) => void;
    /** Offered when the category is in use: switch it off instead of deleting. */
    onDeactivate: (category: CategoryData) => void;
}) {
    const { t } = useTrans();
    const plural = usePlural();
    const [pending, setPending] = useState(false);
    const [inUse, setInUse] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function reset() {
        setPending(false);
        setInUse(false);
        setError(null);
    }

    async function confirm() {
        if (!category) {
            return;
        }

        setPending(true);
        setError(null);

        try {
            await api.delete(widgetsRoutes.api.categories.show(category.ulid));
            onDeleted(category.ulid);
            reset();
        } catch (failure) {
            if (isApiError(failure) && failure.code === 'category_in_use') {
                setInUse(true);
            } else {
                setError(describeApiError(failure, t));
            }

            setPending(false);
        }
    }

    return (
        <AlertDialog
            open={category !== null}
            onOpenChange={(open) => {
                if (!open) {
                    reset();
                    onClose();
                }
            }}
        >
            <AlertDialogContent data-testid="category-delete-dialog">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t('categories.delete.title', {
                            name: category?.name ?? '',
                        })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('categories.delete.body', {
                            agents: plural(
                                'categories.agents_count',
                                category?.agents_count ?? 0,
                            ),
                            widgets: plural(
                                'categories.widgets_count',
                                category?.widgets_count ?? 0,
                            ),
                        })}
                    </AlertDialogDescription>
                </AlertDialogHeader>

                {inUse && category && (
                    <Notice tone="warning" data-testid="category-in-use-notice">
                        <p className="font-medium">
                            {t('categories.delete.in_use_title')}
                        </p>
                        <p className="mt-0.5">
                            {t('categories.delete.in_use_body')}
                        </p>
                        {category.is_active && (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="mt-2 bg-background"
                                data-testid="category-deactivate-instead"
                                onClick={() => {
                                    onDeactivate(category);
                                    reset();
                                    onClose();
                                }}
                            >
                                {t('categories.delete.deactivate_instead')}
                            </Button>
                        )}
                    </Notice>
                )}

                {error && <Notice tone="danger">{error}</Notice>}

                <AlertDialogFooter>
                    <AlertDialogCancel>
                        {t('categories.delete.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={pending || inUse}
                        data-testid="category-delete-confirm"
                        onClick={(event) => {
                            event.preventDefault();
                            void confirm();
                        }}
                    >
                        {pending && <Busy />}
                        {t('categories.delete.confirm')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
