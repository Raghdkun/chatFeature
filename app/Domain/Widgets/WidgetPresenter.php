<?php

namespace App\Domain\Widgets;

use App\Data\Catalog\CategoryData;
use App\Data\Widgets\GreetingData;
use App\Data\Widgets\WidgetBuilderData;
use App\Data\Widgets\WidgetData;
use App\Data\Widgets\WidgetListItemData;
use App\Data\Widgets\WidgetPreviewData;
use App\Domain\Widgets\Config\ConfigMirror;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Embed\EmbedSnippetBuilder;
use App\Domain\Widgets\Support\AppOrigin;
use App\Models\Category;
use App\Models\Widget;
use App\Models\WidgetDomain;
use App\Models\WidgetGreeting;

/**
 * Turns widgets into the dashboard payloads of docs/contracts/dashboard-pages-p3.md.
 */
final class WidgetPresenter
{
    public function __construct(
        private readonly WidgetConfigValidator $configs,
        private readonly EmbedSnippetBuilder $snippets,
        private readonly AppOrigin $origin,
    ) {}

    public function hasUnpublishedChanges(Widget $widget): bool
    {
        return $this->configs->hydrate($widget->draft_config)->toArray() !== $this->configs->hydrate($widget->config)->toArray();
    }

    public function data(Widget $widget): WidgetData
    {
        return WidgetData::fromWidget($widget, $this->hasUnpublishedChanges($widget));
    }

    /**
     * @param  iterable<Widget>  $widgets  loaded `withCount(['domains', 'categories'])`
     * @return array<int, WidgetListItemData>
     */
    public function listItems(iterable $widgets): array
    {
        $items = [];

        foreach ($widgets as $widget) {
            $items[] = WidgetListItemData::fromWidget($widget, $this->hasUnpublishedChanges($widget));
        }

        return $items;
    }

    public function builder(Widget $widget): WidgetBuilderData
    {
        $categories = Category::query()
            ->withCount(['users as agents_count' => fn ($query) => $query->where('users.is_active', true)->where('users.is_agent', true), 'widgets'])
            ->orderBy('sort_order')
            ->orderBy('name')
            ->get();

        return new WidgetBuilderData(
            widget: $this->data($widget),
            config: $this->configs->hydrate(ConfigMirror::overlayColumns($widget->config, $widget)),
            draft_config: $this->configs->hydrate($widget->draft_config),
            greetings: $widget->greetings->map(fn (WidgetGreeting $greeting): GreetingData => GreetingData::fromGreeting($greeting))->values()->all(),
            domains: $widget->domains->map(fn (WidgetDomain $domain): string => $domain->host)->values()->all(),
            category_ulids: $widget->categories->map(fn (Category $category): string => $category->ulid)->values()->all(),
            all_categories: $categories->map(fn (Category $category): CategoryData => CategoryData::fromCategory($category))->values()->all(),
            snippets: $this->snippets->build($widget),
            preview: new WidgetPreviewData(
                embed_url: $this->origin->url().'/embed/'.$widget->public_key.'?preview=1',
                app_origin: $this->origin->url(),
            ),
        );
    }
}
