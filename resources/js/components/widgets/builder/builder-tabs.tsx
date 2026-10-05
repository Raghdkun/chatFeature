import {
    Clock,
    Code,
    Globe,
    Languages,
    MessageCircleMore,
    Palette,
    SlidersHorizontal,
    Sparkles,
    Tags,
    ToggleRight,
    type LucideIcon,
} from 'lucide-react';
import {
    BUILDER_TABS,
    builderTabLabelKey,
    tabsWithErrors,
    type BuilderTab,
} from '@/components/widgets/builder-state';
import { BrandingTab } from '@/components/widgets/builder/branding-tab';
import { CategoriesTab } from '@/components/widgets/builder/categories-tab';
import { DomainsTab } from '@/components/widgets/builder/domains-tab';
import { EmbedTab } from '@/components/widgets/builder/embed-tab';
import { FeaturesTab } from '@/components/widgets/builder/features-tab';
import { GeneralTab } from '@/components/widgets/builder/general-tab';
import { GreetingsTab } from '@/components/widgets/builder/greetings-tab';
import { HoursTab } from '@/components/widgets/builder/hours-tab';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import { TextsTab } from '@/components/widgets/builder/texts-tab';
import { WhatsAppTab } from '@/components/widgets/builder/whatsapp-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTrans } from '@/hooks/use-trans';
import type { CategoryData, WidgetSnippetsData } from '@/types/widgets';

const TAB_ICONS: Record<BuilderTab, LucideIcon> = {
    general: SlidersHorizontal,
    branding: Palette,
    texts: Languages,
    features: ToggleRight,
    whatsapp: MessageCircleMore,
    greetings: Sparkles,
    hours: Clock,
    domains: Globe,
    categories: Tags,
    embed: Code,
};

export function BuilderTabs({
    state,
    dispatch,
    tab,
    onTabChange,
    categories,
    snippets,
    hasUnpublished,
    busy,
    onSetEnabled,
    onRotateSecret,
    onPreviewGreeting,
    previewingGreeting,
}: TabProps & {
    tab: BuilderTab;
    onTabChange: (tab: BuilderTab) => void;
    categories: CategoryData[];
    snippets: WidgetSnippetsData;
    hasUnpublished: boolean;
    busy: boolean;
    onSetEnabled: (next: boolean) => Promise<string | null>;
    onRotateSecret: () => Promise<string>;
    onPreviewGreeting: (clientId: string) => void;
    previewingGreeting: string | null;
}) {
    const { t } = useTrans();
    const withErrors = tabsWithErrors(state.errors);

    return (
        <Tabs
            value={tab}
            onValueChange={(value) => onTabChange(value as BuilderTab)}
            className="min-w-0 gap-4"
        >
            <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
                <TabsList
                    aria-label={t('builder.tabs.label')}
                    className="h-auto w-max max-w-none flex-nowrap justify-start gap-0.5 group-data-[orientation=horizontal]/tabs:h-auto sm:w-full sm:flex-wrap"
                >
                    {BUILDER_TABS.map((value) => {
                        const Icon = TAB_ICONS[value];

                        return (
                            <TabsTrigger
                                key={value}
                                value={value}
                                data-testid={`builder-tab-${value}`}
                                className="h-8 flex-none gap-1.5 px-3 text-foreground/70"
                            >
                                <Icon aria-hidden />
                                {t(builderTabLabelKey(value))}
                                {withErrors.has(value) && (
                                    <>
                                        <span
                                            aria-hidden
                                            data-testid={`builder-tab-${value}-error`}
                                            className="size-1.5 rounded-full bg-red-500"
                                        />
                                        <span className="sr-only">
                                            {t('builder.tabs.has_errors')}
                                        </span>
                                    </>
                                )}
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </div>

            <TabsContent value="general">
                <GeneralTab
                    state={state}
                    dispatch={dispatch}
                    busy={busy}
                    onSetEnabled={onSetEnabled}
                />
            </TabsContent>
            <TabsContent value="branding">
                <BrandingTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="texts">
                <TextsTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="features">
                <FeaturesTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="whatsapp">
                <WhatsAppTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="greetings">
                <GreetingsTab
                    state={state}
                    dispatch={dispatch}
                    onPreviewGreeting={onPreviewGreeting}
                    previewingId={previewingGreeting}
                />
            </TabsContent>
            <TabsContent value="hours">
                <HoursTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="domains">
                <DomainsTab state={state} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="categories">
                <CategoriesTab
                    state={state}
                    dispatch={dispatch}
                    categories={categories}
                />
            </TabsContent>
            <TabsContent value="embed">
                <EmbedTab
                    state={state}
                    snippets={snippets}
                    hasUnpublished={hasUnpublished}
                    onRotateSecret={onRotateSecret}
                    onTabChange={onTabChange}
                />
            </TabsContent>
        </Tabs>
    );
}
