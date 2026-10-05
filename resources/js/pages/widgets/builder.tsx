import { Head } from '@inertiajs/react';
import { useState, type ReactNode } from 'react';
import { BuilderHeader } from '@/components/widgets/builder/builder-header';
import { BuilderTabs } from '@/components/widgets/builder/builder-tabs';
import { useWidgetBuilder } from '@/components/widgets/builder/use-widget-builder';
import {
    BUILDER_TABS,
    type BuilderTab,
} from '@/components/widgets/builder-state';
import { BuilderPreview } from '@/components/widgets/builder-preview';
import { SegmentedChoice } from '@/components/widgets/form-bits';
import { PageShell } from '@/components/widgets/page-chrome';
import { useMediaQuery } from '@/components/widgets/use-media-query';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { categoryLabel } from '@/lib/widget-config';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetBuilderData } from '@/types/widgets';

type View = 'edit' | 'preview';

/** `?tab=domains` opens the builder on that tab (the dashboard's setup checklist links to the step that is missing). */
function initialTab(): BuilderTab {
    if (typeof window === 'undefined') {
        return 'general';
    }

    const wanted = new URLSearchParams(window.location.search).get('tab');

    return BUILDER_TABS.find((tab) => tab === wanted) ?? 'general';
}

/** Editor (tabs) + live preview. Wide screens show both; narrow ones switch between them. */
export default function WidgetBuilder(data: WidgetBuilderData) {
    const { t } = useTrans();
    const builder = useWidgetBuilder(data);
    const { state, dispatch } = builder;
    const wide = useMediaQuery('(min-width: 1280px)');
    const [tab, setTab] = useState<BuilderTab>(initialTab);
    const [view, setView] = useState<View>('edit');
    const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({
        id: null,
        nonce: 0,
    });

    const { config } = state.doc;
    const showEditor = wide || view === 'edit';
    const showPreview = wide || view === 'preview';
    const enabledCategories = state.doc.categoryUlids
        .map((ulid) =>
            data.all_categories.find((category) => category.ulid === ulid),
        )
        .filter((category) => category !== undefined)
        .map((category) => ({
            slug: category.slug,
            label: categoryLabel(category, config.defaultLocale),
        }));

    async function save() {
        const outcome = await builder.saveDraft();

        if (!outcome.ok && outcome.tab) {
            setTab(outcome.tab);
        }
    }

    async function publish() {
        const outcome = await builder.publish();

        if (!outcome.ok && outcome.tab) {
            setTab(outcome.tab);
        }
    }

    return (
        <>
            <Head title={state.doc.settings.name} />

            <PageShell
                wide
                testId="builder-page"
                className="gap-4 pt-0 md:pt-0"
            >
                <BuilderHeader
                    name={state.doc.settings.name}
                    enabled={state.doc.settings.is_enabled}
                    configVersion={state.meta.configVersion}
                    dirty={builder.dirty}
                    hasUnpublished={builder.hasUnpublished}
                    status={builder.status}
                    message={builder.message}
                    onSave={() => void save()}
                    onPublish={() => void publish()}
                />

                {!wide && (
                    <SegmentedChoice<View>
                        legend={t('builder.view.label')}
                        hideLegend
                        name="builder-view"
                        value={view}
                        onChange={setView}
                        options={[
                            { value: 'edit', label: t('builder.view.edit') },
                            {
                                value: 'preview',
                                label: t('builder.view.preview'),
                            },
                        ]}
                        variant="segmented"
                        testId="builder-view-switch"
                    />
                )}

                <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
                    {showEditor && (
                        <div className="min-w-0">
                            <BuilderTabs
                                state={state}
                                dispatch={dispatch}
                                tab={tab}
                                onTabChange={setTab}
                                categories={data.all_categories}
                                snippets={data.snippets}
                                hasUnpublished={builder.hasUnpublished}
                                busy={builder.status !== 'idle'}
                                onSetEnabled={builder.setEnabled}
                                onRotateSecret={builder.rotateSecret}
                                previewingGreeting={focus.id}
                                onPreviewGreeting={(clientId) => {
                                    setFocus((current) => ({
                                        id: clientId,
                                        nonce: current.nonce + 1,
                                    }));
                                    setView('preview');
                                }}
                            />
                        </div>
                    )}

                    {showPreview && (
                        <div className="min-w-0 xl:sticky xl:top-28">
                            <BuilderPreview
                                widgetKey={state.meta.publicKey}
                                configVersion={state.meta.configVersion}
                                config={config}
                                greetings={state.doc.greetings}
                                categories={enabledCategories}
                                preview={data.preview}
                                greetingFocus={focus}
                            />
                        </div>
                    )}
                </div>
            </PageShell>
        </>
    );
}

WidgetBuilder.layout = BuilderLayout;

function BuilderLayout({
    children,
    widget,
}: {
    children: ReactNode;
    widget?: { ulid: string; name: string };
}) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('widgets.title'),
                    href: widgetsRoutes.pages.widgets(),
                },
                {
                    title: widget?.name ?? t('builder.breadcrumb'),
                    href: widget
                        ? widgetsRoutes.pages.widget(widget.ulid)
                        : widgetsRoutes.pages.widgets(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
