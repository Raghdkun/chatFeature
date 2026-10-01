<?php

namespace App\Data\Widgets;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\Widget;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Row of the widget list. */
#[TypeScript]
class WidgetListItemData extends Data
{
    public function __construct(
        public string $ulid,
        public string $name,
        public string $public_key,
        public bool $is_enabled,
        public int $config_version,
        public bool $has_unpublished_changes,
        public bool $whatsapp_connected,
        public string $updated_at,
        public int $domains_count,
        public int $categories_count,
    ) {}

    public static function fromWidget(Widget $widget, bool $hasUnpublishedChanges): self
    {
        return new self(
            ulid: $widget->ulid,
            name: $widget->name,
            public_key: $widget->public_key,
            is_enabled: $widget->is_enabled,
            config_version: $widget->config_version,
            has_unpublished_changes: $hasUnpublishedChanges,
            whatsapp_connected: false,
            updated_at: (string) Timestamps::iso($widget->updated_at),
            domains_count: (int) $widget->domains_count,
            categories_count: (int) $widget->categories_count,
        );
    }
}
