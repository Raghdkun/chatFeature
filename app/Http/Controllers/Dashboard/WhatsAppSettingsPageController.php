<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\Settings\SettingsRepository;
use App\Http\Controllers\Controller;
use App\Models\WaChat;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `settings/whatsapp` (administrators only): the connection to OpenWA, the sessions and the behaviour settings. The OpenWA
 * API key is write-only: the page learns only WHETHER one is saved (`hasApiKey`), never the key. Saving, creating sessions, the QR
 * and the connection test go through the management API (`/api/v1/whatsapp/*`).
 */
class WhatsAppSettingsPageController extends Controller
{
    public function edit(SettingsRepository $settings): Response
    {
        Gate::authorize('viewAny', WaChat::class);

        return Inertia::render('settings/whatsapp', [
            'sessions' => WhatsAppSession::query()->withCount('widgets')->orderBy('name')->get()
                ->map(fn (WhatsAppSession $session): array => WhatsAppSessionData::fromModel($session)->toArray())->values()->all(),
            'settings' => [
                'enabled' => $settings->bool('whatsapp.enabled', false),
                'baseUrl' => $settings->string('whatsapp.openwa.base_url', 'http://127.0.0.1:2785'),
                'hasApiKey' => $settings->has('whatsapp.openwa.api_key'),
                'handoffText' => $settings->string('whatsapp.handoff_text', 'Hi! My support code is :code'),
                'handoffTtlMinutes' => $settings->int('whatsapp.handoff_ttl_minutes', 1440),
                'ignoreGroups' => $settings->bool('whatsapp.ignore_groups', true),
                'replyOnlyToInbound' => $settings->bool('whatsapp.reply_only_to_inbound', true),
                'sendMinIntervalMs' => $settings->int('whatsapp.send_min_interval_ms', 1500),
                'dailySendCap' => $settings->int('whatsapp.daily_send_cap', 200),
                'mediaMaxBytes' => $settings->int('whatsapp.media_max_bytes', 5 * 1024 * 1024),
            ],
        ]);
    }
}
