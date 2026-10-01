import { router } from '@inertiajs/react';
import { useId, useState, type FormEvent } from 'react';
import { Busy, Notice, TextField } from '@/components/widgets/form-bits';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { LIMITS } from '@/lib/widget-config';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetData } from '@/types/widgets';

/** Name only; the new widget opens straight in the builder where everything else gets configured. */
export function CreateWidgetDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t } = useTrans();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-testid="widget-create-dialog"
                className="sm:max-w-md"
            >
                <DialogHeader className="text-start sm:text-start">
                    <DialogTitle>{t('widgets.create.title')}</DialogTitle>
                    <DialogDescription>
                        {t('widgets.create.description')}
                    </DialogDescription>
                </DialogHeader>
                <CreateForm onCancel={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

function CreateForm({ onCancel }: { onCancel: () => void }) {
    const { t } = useTrans();
    const id = useId();
    const [name, setName] = useState('');
    const [error, setError] = useState<string | undefined>();
    const [formError, setFormError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const trimmed = name.trim();

        setFormError(null);

        if (trimmed === '') {
            setError(t('widgets.create.name_required'));

            return;
        }

        setError(undefined);
        setPending(true);

        try {
            const widget = await api.post<WidgetData>(
                widgetsRoutes.api.widgets.index(),
                { name: trimmed },
            );

            // Keep the button busy while the builder page loads.
            router.visit(widgetsRoutes.pages.widget(widget.ulid));
        } catch (failure) {
            setPending(false);

            if (isApiError(failure) && failure.isValidation) {
                setError(
                    failure.firstMessage('name') ?? failure.firstMessage(),
                );
            } else {
                setFormError(describeApiError(failure, t));
            }
        }
    }

    return (
        <form onSubmit={submit} noValidate className="grid gap-4">
            {formError && <Notice tone="danger">{formError}</Notice>}
            <TextField
                id={`${id}-name`}
                label={t('widgets.create.name')}
                hint={t('widgets.create.name_hint')}
                value={name}
                onValueChange={(value) => {
                    setName(value);
                    setError(undefined);
                }}
                maxLength={LIMITS.nameLength}
                error={error}
                placeholder={t('widgets.create.name_placeholder')}
                autoComplete="off"
                required
            />
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onCancel}>
                    {t('widgets.create.cancel')}
                </Button>
                <Button
                    type="submit"
                    disabled={pending}
                    data-testid="widget-create-submit"
                >
                    {pending && <Busy />}
                    {t('widgets.create.submit')}
                </Button>
            </DialogFooter>
        </form>
    );
}
