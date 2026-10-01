import { Head, Link, usePage } from '@inertiajs/react';
import { LayoutTemplate, Tags } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CategoryTile } from '@/components/categories/category-visuals';
import { toggleUlid } from '@/components/agents/agent-model';
import Heading from '@/components/heading';
import { Busy, Notice } from '@/components/widgets/form-bits';
import { usePlural } from '@/components/widgets/page-chrome';
import { useUnsavedChangesGuard } from '@/components/widgets/use-unsaved-guard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import SettingsLayout from '@/layouts/settings/layout';
import { api, describeApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { CategoryData } from '@/types/widgets';

type Props = { categories: CategoryData[]; selected: string[] };

function sameSet(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((ulid) => b.includes(ulid));
}

/** "My support categories": any agent picks which categories they take chats for. */
export default function SupportCategories({ categories, selected }: Props) {
    const { t } = useTrans();
    const { auth } = usePage().props;
    // Only people who take chats serve categories; saving is refused (403) for everyone else.
    const isAgent = auth?.user?.is_agent === true;
    const isAdmin = auth?.user?.is_admin === true;
    const plural = usePlural();
    const uid = useId();
    // Only active categories can be served; anything else in `selected` is stale.
    const active = categories.filter((category) => category.is_active);
    const initial = selected.filter((ulid) =>
        active.some((category) => category.ulid === ulid),
    );
    const [saved, setSaved] = useState(initial);
    const [chosen, setChosen] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justSaved, setJustSaved] = useState(false);
    const dirty = !sameSet(saved, chosen);

    useUnsavedChangesGuard(dirty, t('categories.support.leave_confirm'));

    async function save() {
        setSaving(true);
        setError(null);

        try {
            await api.put(widgetsRoutes.api.me.categories(), {
                category_ulids: chosen,
            });
            setSaved(chosen);
            setJustSaved(true);
            toast.success(t('categories.support.toast_saved'));
        } catch (failure) {
            setError(describeApiError(failure, t));
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <Head title={t('categories.support.title')} />

            <h1 className="sr-only">{t('categories.support.title')}</h1>

            <div className="space-y-6" data-testid="support-categories-page">
                <Heading
                    variant="small"
                    title={t('categories.support.title')}
                    description={t('categories.support.description')}
                />

                {!isAgent ? (
                    <Notice data-testid="support-categories-not-agent">
                        <p className="font-medium">
                            {t('categories.support.not_agent_title')}
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                            {t('categories.support.not_agent_body')}
                        </p>
                        {isAdmin && (
                            <Link
                                href={widgetsRoutes.pages.agents()}
                                data-testid="support-categories-agents-link"
                                className="mt-1.5 inline-block font-medium underline underline-offset-4"
                            >
                                {t('categories.support.not_agent_action')}
                            </Link>
                        )}
                    </Notice>
                ) : active.length === 0 ? (
                    <Empty
                        data-testid="support-categories-empty"
                        className="border bg-card"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Tags aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>
                                {t('categories.support.empty_title')}
                            </EmptyTitle>
                            <EmptyDescription>
                                {t('categories.support.empty_body')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <>
                        <ul className="grid gap-2.5">
                            {active.map((category) => {
                                const id = `${uid}-${category.ulid}`;
                                const checked = chosen.includes(category.ulid);
                                const widgetNames = category.widgets?.map(
                                    (widget) => widget.name,
                                );

                                return (
                                    <li key={category.ulid}>
                                        <label
                                            htmlFor={id}
                                            data-testid={`support-category-${category.ulid}`}
                                            className="flex cursor-pointer items-start gap-3.5 rounded-xl border bg-card p-3.5 transition-colors hover:bg-accent/40 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-accent/50"
                                        >
                                            <Checkbox
                                                id={id}
                                                checked={checked}
                                                onCheckedChange={() => {
                                                    setChosen((current) =>
                                                        toggleUlid(
                                                            current,
                                                            category.ulid,
                                                        ),
                                                    );
                                                    setJustSaved(false);
                                                }}
                                                className="mt-1 size-5"
                                                data-testid={`support-category-check-${category.ulid}`}
                                            />
                                            <CategoryTile
                                                icon={category.icon}
                                                color={category.color}
                                            />
                                            <span className="grid min-w-0 gap-1">
                                                <span className="font-medium">
                                                    {category.name}
                                                </span>
                                                {category.description && (
                                                    <span className="text-sm text-muted-foreground">
                                                        {category.description}
                                                    </span>
                                                )}
                                                <span
                                                    data-testid={`support-category-widgets-${category.ulid}`}
                                                    className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
                                                >
                                                    <LayoutTemplate
                                                        className="size-3.5"
                                                        aria-hidden
                                                    />
                                                    {category.widgets_count ===
                                                    0
                                                        ? t(
                                                              'categories.support.no_widgets',
                                                          )
                                                        : widgetNames &&
                                                            widgetNames.length >
                                                                0
                                                          ? t(
                                                                'categories.support.in_widgets',
                                                                {
                                                                    names: widgetNames.join(
                                                                        ', ',
                                                                    ),
                                                                },
                                                            )
                                                          : plural(
                                                                'categories.widgets_offered',
                                                                category.widgets_count,
                                                            )}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>

                        {error && (
                            <Notice
                                tone="danger"
                                data-testid="support-categories-error"
                            >
                                {error}
                            </Notice>
                        )}

                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                onClick={() => void save()}
                                disabled={!dirty || saving}
                                data-testid="support-categories-save"
                            >
                                {saving && <Busy />}
                                {t('categories.support.save')}
                            </Button>
                            <p
                                role="status"
                                aria-live="polite"
                                data-testid="support-categories-status"
                                className="text-sm text-muted-foreground"
                            >
                                {dirty
                                    ? t('categories.support.unsaved')
                                    : justSaved
                                      ? t('categories.support.saved')
                                      : plural(
                                            'categories.support.selected',
                                            chosen.length,
                                        )}
                            </p>
                        </div>
                    </>
                )}
            </div>
        </>
    );
}

SupportCategories.layout = [SupportCategoriesAppLayout, SettingsLayout];

function SupportCategoriesAppLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('categories.support.title'),
                    href: widgetsRoutes.pages.supportCategories(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
