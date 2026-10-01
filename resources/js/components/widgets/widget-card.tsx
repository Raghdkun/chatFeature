import { Link } from '@inertiajs/react';
import { Globe, MessagesSquare, PencilRuler, Tags, Trash2 } from 'lucide-react';
import { CopyButton } from '@/components/widgets/form-bits';
import {
    formatRelativeTime,
    usePlural,
} from '@/components/widgets/page-chrome';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';
import { cn } from '@/lib/utils';
import type { WidgetListItemData } from '@/types/widgets';

export function WidgetCard({
    widget,
    onToggleEnabled,
    onDelete,
}: {
    widget: WidgetListItemData;
    onToggleEnabled: (widget: WidgetListItemData, enabled: boolean) => void;
    onDelete: (widget: WidgetListItemData) => void;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const switchId = `widget-enabled-${widget.ulid}`;
    const updated = formatRelativeTime(widget.updated_at, locale);

    return (
        <li
            data-testid={`widget-card-${widget.ulid}`}
            data-enabled={widget.is_enabled}
            className={cn(
                'flex flex-col rounded-xl border bg-card transition-colors',
                !widget.is_enabled && 'bg-muted/30',
            )}
        >
            <div className="flex items-start gap-3 p-4 pb-3">
                <span
                    aria-hidden
                    className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-lg',
                        widget.is_enabled
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground',
                    )}
                >
                    <MessagesSquare className="size-5" />
                </span>
                <div className="grid min-w-0 flex-1 gap-1">
                    <h2 className="truncate font-semibold tracking-tight">
                        <Link
                            href={widgetsRoutes.pages.widget(widget.ulid)}
                            className="hover:underline focus-visible:underline"
                            data-testid={`widget-link-${widget.ulid}`}
                        >
                            {widget.name}
                        </Link>
                    </h2>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <code
                            dir="ltr"
                            className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                            data-testid={`widget-key-${widget.ulid}`}
                        >
                            {widget.public_key}
                        </code>
                        <CopyButton
                            value={widget.public_key}
                            label={t('widgets.copy_key')}
                            testId={`widget-copy-key-${widget.ulid}`}
                            className="h-6 px-2"
                        />
                        <span
                            className="text-xs text-muted-foreground tabular-nums"
                            data-testid={`widget-version-${widget.ulid}`}
                        >
                            {t('widgets.badge.version', {
                                version: widget.config_version,
                            })}
                        </span>
                    </div>
                </div>
            </div>

            <div
                className={cn(
                    'flex flex-wrap items-center gap-1.5 px-4 pb-3',
                    !widget.has_unpublished_changes &&
                        !widget.whatsapp_connected &&
                        'hidden',
                )}
            >
                {widget.has_unpublished_changes && (
                    <Badge
                        variant="outline"
                        className="border-amber-400/70 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
                        data-testid={`widget-unpublished-${widget.ulid}`}
                    >
                        {t('widgets.badge.unpublished')}
                    </Badge>
                )}
                {widget.whatsapp_connected && (
                    <Badge
                        variant="outline"
                        className="border-emerald-400/60 bg-emerald-50 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200"
                        data-testid={`widget-whatsapp-${widget.ulid}`}
                    >
                        {t('widgets.badge.whatsapp')}
                    </Badge>
                )}
            </div>

            <dl className="grid grid-cols-2 gap-3 border-t px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                    <Globe
                        className="size-4 text-muted-foreground"
                        aria-hidden
                    />
                    <dt className="sr-only">{t('widgets.stat.domains')}</dt>
                    <dd>
                        {plural('widgets.domains_count', widget.domains_count)}
                    </dd>
                </div>
                <div className="flex items-center gap-2">
                    <Tags
                        className="size-4 text-muted-foreground"
                        aria-hidden
                    />
                    <dt className="sr-only">{t('widgets.stat.categories')}</dt>
                    <dd>
                        {plural(
                            'widgets.categories_count',
                            widget.categories_count,
                        )}
                    </dd>
                </div>
            </dl>

            <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-4 py-3">
                <div className="flex items-center gap-2">
                    <Switch
                        id={switchId}
                        checked={widget.is_enabled}
                        onCheckedChange={(checked) =>
                            onToggleEnabled(widget, checked)
                        }
                        data-testid={switchId}
                    />
                    <Label htmlFor={switchId} className="text-sm font-normal">
                        {widget.is_enabled
                            ? t('widgets.enabled')
                            : t('widgets.disabled')}
                    </Label>
                </div>
                <div className="flex items-center gap-1">
                    {updated && (
                        <span className="me-1 hidden text-xs text-muted-foreground sm:inline">
                            {t('widgets.updated', { when: updated })}
                        </span>
                    )}
                    <Button
                        asChild
                        size="sm"
                        variant="outline"
                        data-testid={`widget-edit-${widget.ulid}`}
                    >
                        <Link href={widgetsRoutes.pages.widget(widget.ulid)}>
                            <PencilRuler aria-hidden />
                            {t('widgets.open_builder')}
                        </Link>
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8 text-destructive-foreground hover:text-destructive-foreground"
                        aria-label={t('widgets.delete_action', {
                            name: widget.name,
                        })}
                        data-testid={`widget-delete-${widget.ulid}`}
                        onClick={() => onDelete(widget)}
                    >
                        <Trash2 aria-hidden />
                    </Button>
                </div>
            </div>
        </li>
    );
}
