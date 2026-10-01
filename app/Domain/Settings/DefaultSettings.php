<?php

namespace App\Domain\Settings;

use Illuminate\Validation\Rule;

/**
 * The settings P1 ships with. Other contexts register theirs through SettingsRegistry::define()
 * in their own service provider.
 */
final class DefaultSettings
{
    /**
     * @return list<SettingDefinition>
     */
    public static function definitions(): array
    {
        return [
            new SettingDefinition('app.name', SettingGroup::App, SettingType::String, fn (): mixed => config('app.name'), ['required', 'string', 'max:100']),
            new SettingDefinition('app.url', SettingGroup::App, SettingType::String, fn (): mixed => config('app.url'), ['required', 'string', 'url:http,https', 'max:255']),
            new SettingDefinition('app.locale', SettingGroup::App, SettingType::String, fn (): mixed => config('app.locale'), ['required', 'string', Rule::in((array) config('chat.locales', ['en']))]),
            new SettingDefinition('app.timezone', SettingGroup::App, SettingType::String, 'UTC', ['required', 'string', 'timezone:all']),
            new SettingDefinition('app.installed', SettingGroup::App, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('auth.mode', SettingGroup::Auth, SettingType::String, 'fortify', ['required', 'string', Rule::in(['fortify', 'pizzasys'])]),
            new SettingDefinition('auth.allow_registration', SettingGroup::Auth, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('chat.default_idle_timeout_minutes', SettingGroup::Chat, SettingType::Int, 120, ['integer', 'min:1', 'max:10080']),
        ];
    }
}
