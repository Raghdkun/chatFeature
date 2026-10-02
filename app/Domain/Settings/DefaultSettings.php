<?php

namespace App\Domain\Settings;

use App\Rules\HandoffText;
use App\Rules\OpenWaBaseUrl;
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
            new SettingDefinition('app.timezone', SettingGroup::App, SettingType::String, 'UTC', ['required', 'string', 'timezone:all_with_bc']),
            new SettingDefinition('app.installed', SettingGroup::App, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('auth.mode', SettingGroup::Auth, SettingType::String, 'fortify', ['required', 'string', Rule::in(['fortify', 'pizzasys'])]),
            new SettingDefinition('auth.allow_registration', SettingGroup::Auth, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('chat.default_idle_timeout_minutes', SettingGroup::Chat, SettingType::Int, 120, ['integer', 'min:5', 'max:10080']),

            // Live chat (P4). Bytes / pixels are limits for visitor and agent image uploads (the total is per conversation); the wave delay is
            // how long online agents are offered a chat before away agents are (docs/realtime.md). The message length stops at 16000
            // characters: `messages.body` is a TEXT column (65,535 bytes) and one character can take 4 bytes.
            new SettingDefinition('chat.rating_window_minutes', SettingGroup::Chat, SettingType::Int, 10, ['integer', 'min:1', 'max:1440']),
            new SettingDefinition('chat.attachment_max_bytes', SettingGroup::Chat, SettingType::Int, 5 * 1024 * 1024, ['integer', 'min:10240', 'max:26214400']),
            new SettingDefinition('chat.attachment_max_dimension', SettingGroup::Chat, SettingType::Int, 4096, ['integer', 'min:256', 'max:8192']),
            new SettingDefinition('chat.visitor_session_ttl_days', SettingGroup::Chat, SettingType::Int, 30, ['integer', 'min:1', 'max:365']),
            new SettingDefinition('chat.offer_wave_delay_seconds', SettingGroup::Chat, SettingType::Int, 20, ['integer', 'min:0', 'max:300']),
            new SettingDefinition('chat.max_message_length', SettingGroup::Chat, SettingType::Int, 4000, ['integer', 'min:100', 'max:16000']),
            new SettingDefinition('chat.attachment_max_total_bytes', SettingGroup::Chat, SettingType::Int, 30 * 1024 * 1024, ['integer', 'min:10240', 'max:524288000']),
            new SettingDefinition('chat.attachment_url_ttl_minutes', SettingGroup::Chat, SettingType::Int, 240, ['integer', 'min:5', 'max:1440']),

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

            // WhatsApp through the self-hosted OpenWA gateway (P6, docs/contracts/whatsapp-data-p6.md). Admin-only. The API key is a secret: encrypted at
            // rest, never seeded, never returned by any API. The base URL is judged like the auth portal's (private hosts need PORTAL_ALLOW_PRIVATE_HOSTS).
            // `reply_only_to_inbound`, the send interval and the daily cap protect the number from a ban; a session may override the last two.
            new SettingDefinition('whatsapp.enabled', SettingGroup::WhatsApp, SettingType::Bool, false, ['boolean']),
            new SettingDefinition('whatsapp.openwa.base_url', SettingGroup::WhatsApp, SettingType::String, 'http://127.0.0.1:2785', ['required', 'string', 'max:255', new OpenWaBaseUrl]),
            new SettingDefinition('whatsapp.openwa.api_key', SettingGroup::WhatsApp, SettingType::String, null, ['nullable', 'string', 'max:255'], encrypted: true, seed: false),
            new SettingDefinition('whatsapp.handoff_ttl_minutes', SettingGroup::WhatsApp, SettingType::Int, 1440, ['integer', 'min:5', 'max:10080']),
            new SettingDefinition('whatsapp.ignore_groups', SettingGroup::WhatsApp, SettingType::Bool, true, ['boolean']),
            new SettingDefinition('whatsapp.reply_only_to_inbound', SettingGroup::WhatsApp, SettingType::Bool, true, ['boolean']),
            new SettingDefinition('whatsapp.send_min_interval_ms', SettingGroup::WhatsApp, SettingType::Int, 1500, ['integer', 'min:0', 'max:60000']),
            new SettingDefinition('whatsapp.daily_send_cap', SettingGroup::WhatsApp, SettingType::Int, 200, ['integer', 'min:1', 'max:10000']),
            new SettingDefinition('whatsapp.handoff_text', SettingGroup::WhatsApp, SettingType::String, 'Hi! My support code is :code', ['required', 'string', new HandoffText]),
            new SettingDefinition('whatsapp.media_max_bytes', SettingGroup::WhatsApp, SettingType::Int, 5 * 1024 * 1024, ['integer', 'min:10240', 'max:26214400']),
        ];
    }
}
