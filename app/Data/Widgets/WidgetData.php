<?php

namespace App\Data\Widgets;

use App\Domain\Widgets\Enums\OfflineMode;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Widget;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A widget as the dashboard sees it. Never carries the identity secret, only whether one exists.
 * `has_unpublished_changes` is computed by the presenter (draft vs published config).
 */
#[TypeScript]
class WidgetData extends Data
{
    public function __construct(
        public string $ulid,
        public string $name,
        public string $public_key,
        public bool $is_enabled,
        public string $locale,
        public int $idle_timeout_minutes,
        public int $queue_timeout_seconds,
        public OfflineMode $offline_mode,
        public string $timezone,
        public bool $allow_non_browser_clients,
        public int $config_version,
        public bool $has_identity_secret,
        public bool $has_unpublished_changes,
        public bool $whatsapp_connected,
        public string $created_at,
        public string $updated_at,
    ) {}

    public static function fromWidget(Widget $widget, bool $hasUnpublishedChanges): self
    {
        return new self(
            ulid: $widget->ulid,
            name: $widget->name,
            public_key: $widget->public_key,
            is_enabled: $widget->is_enabled,
            locale: $widget->locale,
            idle_timeout_minutes: $widget->idle_timeout_minutes,
            queue_timeout_seconds: $widget->queue_timeout_seconds,
            offline_mode: $widget->offline_mode,
            timezone: $widget->timezone,
            allow_non_browser_clients: $widget->allow_non_browser_clients,
            config_version: $widget->config_version,
            has_identity_secret: $widget->hasIdentitySecret(),
            has_unpublished_changes: $hasUnpublishedChanges,
            // The WhatsApp session link arrives with P6.
            whatsapp_connected: false,
            created_at: (string) Timestamps::iso($widget->created_at),
            updated_at: (string) Timestamps::iso($widget->updated_at),
        );
    }
}
