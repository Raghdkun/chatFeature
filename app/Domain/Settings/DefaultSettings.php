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
            new SettingDefinition('chat.default_idle_timeout_minutes', SettingGroup::Chat, SettingType::Int, 120, ['integer', 'min:5', 'max:10080']),

            // Auth mode 2 (pizzasys). The portal's service/NATS secrets are NOT settings: they live encrypted in `auth_environments`.
            new SettingDefinition('auth.pizzasys.active_env', SettingGroup::Auth, SettingType::String, 'production', ['required', 'string', Rule::in(['production', 'testing'])]),
            new SettingDefinition('auth.pizzasys.admin_permission', SettingGroup::Auth, SettingType::String, 'chat.admin', ['required', 'string', 'max:128']),
            new SettingDefinition('auth.pizzasys.agent_permission', SettingGroup::Auth, SettingType::String, 'chat.agent', ['required', 'string', 'max:128']),
            new SettingDefinition('auth.pizzasys.super_roles', SettingGroup::Auth, SettingType::Json, ['super-admin'], ['array', 'max:20']),
            new SettingDefinition('auth.pizzasys.verify_ttl_seconds', SettingGroup::Auth, SettingType::Int, 60, ['integer', 'min:15', 'max:300']),
            new SettingDefinition('auth.pizzasys.grace_minutes', SettingGroup::Auth, SettingType::Int, 30, ['integer', 'min:0', 'max:1440']),
            new SettingDefinition('auth.pizzasys.verify_timeout_seconds', SettingGroup::Auth, SettingType::Int, 3, ['integer', 'min:1', 'max:15']),
            new SettingDefinition('auth.pizzasys.nats.enabled', SettingGroup::Auth, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('auth.pizzasys.nats.ensure_stream', SettingGroup::Auth, SettingType::Bool, true, ['boolean']),
        ];
    }
}
