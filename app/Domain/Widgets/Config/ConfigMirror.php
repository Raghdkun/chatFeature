<?php

namespace App\Domain\Widgets\Config;

use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Enums\OfflineMode;
use App\Models\Widget;

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
    /**
     * @param  array<string, mixed>  $config
     * @return array<string, mixed>
     */
    public static function overlayColumns(array $config, Widget $widget): array
    {
        $config['defaultLocale'] = $widget->locale;
        $config['hours'] = array_merge(is_array($config['hours'] ?? null) ? $config['hours'] : [], [
            'mode' => $widget->offline_mode->value,
            'timezone' => $widget->timezone,
        ]);
        $config['routing'] = array_merge(is_array($config['routing'] ?? null) ? $config['routing'] : [], [
            'queueTimeoutSeconds' => $widget->queue_timeout_seconds,
        ]);
        $config['session'] = array_merge(is_array($config['session'] ?? null) ? $config['session'] : [], [
            'idleTimeoutMinutes' => $widget->idle_timeout_minutes,
        ]);

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
