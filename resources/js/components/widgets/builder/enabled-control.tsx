import { Power, Rocket } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { cn } from '@/lib/utils';

/**
 * Whether the widget loads on the customer's sites at all. It takes effect the moment it is
 * confirmed (its own request) and has nothing to do with "Save draft" or "Publish", so it is a
 * deliberate action with a confirmation instead of a switch that quietly rides along with Save.
 */
export function EnabledControl({
    enabled,
    disabled = false,
    onChange,
}: {
    enabled: boolean;
    disabled?: boolean;
    /** Resolves to `null` when the change was applied, or an error message to show in the dialog. */
    onChange: (next: boolean) => Promise<string | null>;
}) {
    const { t } = useTrans();
    const [target, setTarget] = useState<boolean | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function close() {
        setTarget(null);
        setError(null);
    }

    async function confirm() {
        if (target === null) {
            return;
        }

        setPending(true);
        setError(null);

        const failure = await onChange(target);

        setPending(false);

        if (failure === null) {
            close();
        } else {
            setError(failure);
        }
    }

    const goingLive = target === true;

    return (
        <div
            data-testid="builder-enabled"
            data-enabled={enabled}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3"
        >
            <div className="grid min-w-0 gap-1">
                <p className="flex items-center gap-2 text-sm leading-snug font-medium">
                    <span
                        aria-hidden
                        className={cn(
                            'size-2 rounded-full',
                            enabled
                                ? 'bg-emerald-500'
                                : 'bg-muted-foreground/50',
                        )}
                    />
                    <span data-testid="builder-enabled-status">
                        {enabled
                            ? t('builder.enabled.status_live')
                            : t('builder.enabled.status_offline')}
                    </span>
                </p>
                <p className="text-sm text-muted-foreground">
                    {t('builder.enabled.hint')}
                </p>
            </div>

            <Button
                type="button"
                size="sm"
                variant={enabled ? 'outline' : 'default'}
                disabled={disabled}
                onClick={() => setTarget(!enabled)}
                data-testid="builder-enabled-toggle"
            >
                {enabled ? <Power aria-hidden /> : <Rocket aria-hidden />}
                {enabled
                    ? t('builder.enabled.take_offline')
                    : t('builder.enabled.take_live')}
            </Button>

            <AlertDialog
                open={target !== null}
                onOpenChange={(open) => {
                    if (!open && !pending) {
                        close();
                    }
                }}
            >
                <AlertDialogContent data-testid="builder-enabled-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {goingLive
                                ? t('builder.enabled.confirm_live_title')
                                : t('builder.enabled.confirm_offline_title')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {goingLive
                                ? t('builder.enabled.confirm_live_body')
                                : t('builder.enabled.confirm_offline_body')}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {error && (
                        <Notice
                            tone="danger"
                            data-testid="builder-enabled-error"
                        >
                            {error}
                        </Notice>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={pending}>
                            {t('builder.enabled.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={pending}
                            data-testid="builder-enabled-confirm"
                            onClick={(event) => {
                                event.preventDefault();
                                void confirm();
                            }}
                        >
                            {pending && <Busy />}
                            {goingLive
                                ? t('builder.enabled.confirm_live')
                                : t('builder.enabled.confirm_offline')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
