/**
 * Compile-time drift guard between the hand-written dashboard types (`@/types/widgets`, more precise:
 * unions instead of strings) and the PHP-generated `App.Data.*` types. If a PHP Data class and its
 * TypeScript mirror stop agreeing, `npm run types:check` fails here.
 *
 * `Narrower<A, B>` = every A is a valid B (hand-written is a subset of generated).
 */
import type * as W from '@/types/widgets';

type Narrower<A, B> = [A] extends [B] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const widgetPagesConform: {
    widget: Narrower<W.WidgetData, App.Data.Widgets.WidgetData>;
    widgetListItem: Narrower<
        W.WidgetListItemData,
        App.Data.Widgets.WidgetListItemData
    >;
    greeting: Same<W.GreetingData, App.Data.Widgets.GreetingData>;
    snippets: Same<W.WidgetSnippetsData, App.Data.Widgets.WidgetSnippetsData>;
    preview: Same<W.WidgetPreviewData, App.Data.Widgets.WidgetPreviewData>;
    category: Narrower<W.CategoryData, App.Data.Catalog.CategoryData>;
    agent: Narrower<W.AgentListItemData, App.Data.Agents.AgentListItemData>;
} = {
    widget: true,
    widgetListItem: true,
    greeting: true,
    snippets: true,
    preview: true,
    category: true,
    agent: true,
};
