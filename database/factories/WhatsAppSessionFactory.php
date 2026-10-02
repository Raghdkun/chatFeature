<?php

namespace Database\Factories;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Models\WhatsAppSession;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * Default: a session OpenWA just created (`created`, not started, no webhook yet). One state per status keeps the columns consistent
 * with the state machine (`starting()`, `qr()`, `ready()`, `disconnected()`, `failed()`); `withWebhook()` adds a registered webhook and
 * its secret (`ready()` includes it).
 *
 * @extends Factory<WhatsAppSession>
 */
class WhatsAppSessionFactory extends Factory
{
    /** The smallest valid PNG: stands in for the QR image OpenWA renders. */
    public const FAKE_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => null,
            'name' => 'support-'.Str::lower(Str::random(8)),
            'openwa_session_id' => fake()->uuid(),
            'openwa_webhook_id' => null,
            'engine' => 'whatsapp-web.js',
            'status' => SessionStatus::Created,
            'phone_e164' => null,
            'push_name' => null,
            'webhook_secret' => null,
            'webhook_registered_at' => null,
            'last_qr' => null,
            'last_qr_at' => null,
            'ready_at' => null,
            'last_error' => null,
            'settings' => null,
        ];
    }

    /** Start requested, the engine is connecting. */
    public function starting(): static
    {
        return $this->withWebhook()->state(fn (): array => ['status' => SessionStatus::Starting]);
    }

    /** Waiting for the phone to scan the QR. */
    public function qr(): static
    {
        return $this->withWebhook()->state(fn (): array => [
            'status' => SessionStatus::Qr,
            'last_qr' => self::FAKE_QR,
            'last_qr_at' => now(),
        ]);
    }

    /** Connected to a phone number. */
    public function ready(?string $phone = null): static
    {
        return $this->withWebhook()->state(fn (): array => [
            'status' => SessionStatus::Ready,
            'phone_e164' => $phone ?? '+49'.fake()->numerify('1#########'),
            'push_name' => fake()->company(),
            'ready_at' => now(),
        ]);
    }

    /** The phone went away (or the session was stopped). */
    public function disconnected(): static
    {
        return $this->ready()->state(fn (): array => ['status' => SessionStatus::Disconnected, 'ready_at' => null, 'last_error' => 'Connection lost']);
    }

    /** The engine could not start or was refused by WhatsApp. */
    public function failed(string $error = 'The engine did not finish starting.'): static
    {
        return $this->withWebhook()->state(fn (): array => ['status' => SessionStatus::Failed, 'last_error' => $error]);
    }

    /** The webhook is registered at OpenWA (and its secret known). */
    public function withWebhook(?string $secret = null): static
    {
        return $this->state(fn (): array => [
            'openwa_webhook_id' => fake()->uuid(),
            'webhook_secret' => $secret ?? Str::random(48),
            'webhook_registered_at' => now(),
        ]);
    }

    /**
     * Pacing overrides of this session.
     */
    public function withPacing(?int $sendMinIntervalMs = null, ?int $dailySendCap = null): static
    {
        return $this->state(fn (): array => ['settings' => array_filter([
            'send_min_interval_ms' => $sendMinIntervalMs,
            'daily_send_cap' => $dailySendCap,
        ], static fn (?int $value): bool => $value !== null)]);
    }
}
