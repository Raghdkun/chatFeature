import { Link } from '@inertiajs/react';
import { ArrowLeft, CircleCheck, CircleDot, Rocket, Save } from 'lucide-react';
import { useState } from 'react';
import type {
    BuilderMessage,
    BuilderStatus,
} from '@/components/widgets/builder/use-widget-builder';
import { Busy } from '@/components/widgets/form-bits';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';
import { cn } from '@/lib/utils';

export function BuilderHeader({
    name,
    enabled,
    configVersion,
    dirty,
    hasUnpublished,
    status,
    message,
    onSave,
    onPublish,
}: {
    name: string;
    enabled: boolean;
    configVersion: number;
    dirty: boolean;
    hasUnpublished: boolean;
    status: BuilderStatus;
    message: BuilderMessage | null;
    onSave: () => void;
    onPublish: () => void;
}) {
    const { t } = useTrans();
    const [confirming, setConfirming] = useState(false);
    const busy = status !== 'idle';
    const canPublish = dirty || hasUnpublished;

    return (
        <header
            data-testid="builder-header"
            className="sticky top-0 z-30 -mx-4 grid gap-3 border-b bg-background/90 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/95 md:-mx-6 md:px-6"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="grid min-w-0 gap-1">
                    <Link
                        href={widgetsRoutes.pages.widgets()}
                        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft
                            className="size-3.5 rtl:-scale-x-100"
                            aria-hidden
                        />
                        {t('builder.back')}
                    </Link>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <h1
                            className="max-w-[28ch] truncate text-xl font-semibold tracking-tight"
                            data-testid="builder-title"
                        >
                            {name || t('builder.untitled')}
                        </h1>
                        <StateBadge
                            dirty={dirty}
                            hasUnpublished={hasUnpublished}
                            configVersion={configVersion}
                        />
                        {!enabled && (
                            <Badge
                                variant="outline"
                                data-testid="builder-badge-disabled"
                            >
                                {t('builder.badge.disabled')}
                            </Badge>
                        )}
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!dirty || busy}
                        onClick={onSave}
                        data-testid="builder-save"
                    >
                        {status === 'saving' ? <Busy /> : <Save aria-hidden />}
                        {t('builder.save.action')}
                    </Button>
                    <Button
                        type="button"
                        disabled={!canPublish || busy}
                        onClick={() => setConfirming(true)}
                        data-testid="builder-publish"
                    >
                        {status === 'publishing' ? (
                            <Busy />
                        ) : (
                            <Rocket aria-hidden />
                        )}
                        {t('builder.publish.action')}
                    </Button>
                </div>
            </div>

            <p
                role="status"
                aria-live="polite"
                data-testid="builder-status-message"
                data-tone={message?.tone}
                className={cn(
                    message ? 'min-h-5 text-sm' : 'sr-only',
                    message?.tone === 'error'
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-muted-foreground',
                )}
            >
                {message?.text}
            </p>

            <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent data-testid="builder-publish-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {t('builder.publish.confirm_title')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {dirty
                                ? t('builder.publish.confirm_body_dirty')
                                : t('builder.publish.confirm_body')}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>
                            {t('builder.publish.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            data-testid="builder-publish-confirm"
                            onClick={() => onPublish()}
                        >
                            {t('builder.publish.confirm')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </header>
    );
}

function StateBadge({
    dirty,
    hasUnpublished,
    configVersion,
}: {
    dirty: boolean;
    hasUnpublished: boolean;
    configVersion: number;
}) {
    const { t } = useTrans();

    if (dirty) {
        return (
            <Badge
                variant="outline"
                className="gap-1.5 border-amber-400/70 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
                data-testid="builder-badge-dirty"
            >
                <CircleDot aria-hidden />
                {t('builder.badge.unsaved')}
            </Badge>
        );
    }

    if (hasUnpublished) {
        return (
            <Badge
                variant="outline"
                className="gap-1.5 border-sky-400/60 bg-sky-50 text-sky-900 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200"
                data-testid="builder-badge-unpublished"
            >
                <CircleDot aria-hidden />
                {t('builder.badge.unpublished')}
            </Badge>
        );
    }

    return (
        <Badge
            variant="outline"
            className="gap-1.5 border-emerald-400/60 bg-emerald-50 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200"
            data-testid="builder-badge-published"
        >
            <CircleCheck aria-hidden />
            {t('builder.badge.published', { version: configVersion })}
        </Badge>
    );
}
