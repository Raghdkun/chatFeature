<?php

namespace App\Domain\Widgets\Config;

use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Enums\OfflineMode;
use App\Models\Widget;
use Illuminate\Support\Arr;

/**
 * Five operational settings exist twice: as `widgets` columns (what the settings form PATCHes and what the
 * rest of the application reads) and as fields of the config object. The columns are authoritative at runtime;
 * this class keeps the config copies in step:
 *
 * - settings PATCH  -> overlayColumns() into BOTH `config` and `draft_config` (no spurious "unpublished changes");
 * - publish         -> columnsFrom() the freshly published config.
 *
 * Mirrors: `defaultLocale` = `locale`, `hours.mode` = `offline_mode`, `hours.timezone` = `timezone`,
 * `routing.queueTimeoutSeconds` = `queue_timeout_seconds`, `session.idleTimeoutMinutes` = `idle_timeout_minutes`.
 */
final class ConfigMirror
{
    /** Column => the config path it is mirrored at. */
    public const PATHS = [
        'locale' => 'defaultLocale',
        'offline_mode' => 'hours.mode',
        'timezone' => 'hours.timezone',
        'queue_timeout_seconds' => 'routing.queueTimeoutSeconds',
        'idle_timeout_minutes' => 'session.idleTimeoutMinutes',
    ];

    /**
     * Write the widget's column values into the mirrored config fields.
     *
     * @param  array<string, mixed>  $config
     * @param  list<string>|null  $columns  Only these columns (default: all five). A settings change passes just the ones it
     *                                      changed, so unpublished draft edits of the others are left alone.
     * @return array<string, mixed>
     */
    public static function overlayColumns(array $config, Widget $widget, ?array $columns = null): array
    {
        foreach (self::PATHS as $column => $path) {
            if ($columns !== null && ! in_array($column, $columns, true)) {
                continue;
            }

            $value = $widget->{$column};
            Arr::set($config, $path, $value instanceof OfflineMode ? $value->value : $value);
        }

        return $config;
    }

    /**
     * @return array{locale: string, offline_mode: OfflineMode, timezone: string, queue_timeout_seconds: int, idle_timeout_minutes: int}
     */
    public static function columnsFrom(WidgetConfigData $config): array
    {
        return [
            'locale' => $config->defaultLocale,
            'offline_mode' => $config->hours->mode,
            'timezone' => $config->hours->timezone,
            'queue_timeout_seconds' => $config->routing->queueTimeoutSeconds,
            'idle_timeout_minutes' => $config->session->idleTimeoutMinutes,
        ];
    }
}
