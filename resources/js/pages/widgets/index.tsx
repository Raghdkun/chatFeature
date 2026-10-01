import { Head } from '@inertiajs/react';
import { MessagesSquare, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CreateWidgetDialog } from '@/components/widgets/create-widget-dialog';
import { DeleteWidgetDialog } from '@/components/widgets/delete-widget-dialog';
import { PageHeader, PageShell } from '@/components/widgets/page-chrome';
import { WidgetCard } from '@/components/widgets/widget-card';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { api, describeApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetData, WidgetListItemData } from '@/types/widgets';

export default function WidgetsIndex({
    widgets,
}: {
    widgets: WidgetListItemData[];
}) {
    const { t } = useTrans();
    const [items, setItems] = useState<WidgetListItemData[]>(widgets);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<WidgetListItemData | null>(null);

    async function toggleEnabled(widget: WidgetListItemData, enabled: boolean) {
        const before = items;

        setItems((current) =>
            current.map((item) =>
                item.ulid === widget.ulid
                    ? { ...item, is_enabled: enabled }
                    : item,
            ),
        );

        try {
            const saved = await api.patch<Partial<WidgetData>>(
                widgetsRoutes.api.widgets.show(widget.ulid),
                { is_enabled: enabled },
            );

            setItems((current) =>
                current.map((item) =>
                    item.ulid === widget.ulid
                        ? {
                              ...item,
                              is_enabled: saved.is_enabled ?? enabled,
                              updated_at: saved.updated_at ?? item.updated_at,
                          }
                        : item,
                ),
            );
        } catch (error) {
            setItems(before);
            toast.error(describeApiError(error, t));
        }
    }

    return (
        <>
            <Head title={t('widgets.title')} />

            <PageShell testId="widgets-page">
                <PageHeader
                    title={t('widgets.title')}
                    description={t('widgets.description')}
                    actions={
                        items.length > 0 ? (
                            <Button
                                data-testid="widget-create"
                                onClick={() => setCreating(true)}
                            >
                                <Plus aria-hidden />
                                {t('widgets.create.open')}
                            </Button>
                        ) : undefined
                    }
                />

                {items.length === 0 ? (
                    <Empty
                        data-testid="widgets-empty"
                        className="border bg-card"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <MessagesSquare aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>{t('widgets.empty.title')}</EmptyTitle>
                            <EmptyDescription>
                                {t('widgets.empty.body')}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button
                                data-testid="widget-create-empty"
                                onClick={() => setCreating(true)}
                            >
                                <Plus aria-hidden />
                                {t('widgets.create.open')}
                            </Button>
                        </EmptyContent>
                    </Empty>
                ) : (
                    <ul
                        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                        data-testid="widgets-list"
                        aria-label={t('widgets.list_label')}
                    >
                        {items.map((widget) => (
                            <WidgetCard
                                key={widget.ulid}
                                widget={widget}
                                onToggleEnabled={toggleEnabled}
                                onDelete={setDeleting}
                            />
                        ))}
                    </ul>
                )}
            </PageShell>

            <CreateWidgetDialog open={creating} onOpenChange={setCreating} />

            <DeleteWidgetDialog
                widget={deleting}
                onClose={() => setDeleting(null)}
                onDeleted={(ulid) => {
                    setItems((current) =>
                        current.filter((item) => item.ulid !== ulid),
                    );
                    setDeleting(null);
                    toast.success(t('widgets.toast.deleted'));
                }}
            />
        </>
    );
}

WidgetsIndex.layout = WidgetsLayout;

function WidgetsLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('widgets.title'),
                    href: widgetsRoutes.pages.widgets(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
