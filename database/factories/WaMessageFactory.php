<?php

namespace Database\Factories;

use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * Default: an inbound text message of a new chat. The chat's list columns (`last_message_at`, `last_message_preview`, and
 * `last_inbound_at` for inbound rows) are kept in step, so `WaMessage::factory()->count(3)->for($chat)->create()` leaves a coherent chat.
 * States: `outbound()` (an administrator's reply, `pending()` / `delivered()` / `read()` / `failed()` for its progress), and the media
 * kinds `image()`, `document()`, `voice()`.
 *
 * @extends Factory<WaMessage>
 */
class WaMessageFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'wa_chat_id' => WaChat::factory(),
            'direction' => WaDirection::In,
            'wa_message_id' => 'false_'.fake()->numerify('491#########').'@c.us_'.Str::upper(Str::random(20)),
            'type' => WaMessageType::Text,
            'body' => fake()->sentence(),
            'media_path' => null,
            'media_mime' => null,
            'media_filename' => null,
            'media_size' => null,
            'sent_by_user_id' => null,
            'status' => WaMessageStatus::Received,
            'error' => null,
            'announced_at' => now(),
            'wa_timestamp' => now(),
            'raw' => null,
        ];
    }

    public function configure(): static
    {
        return $this->afterCreating(function (WaMessage $message): void {
            $chat = WaChat::query()->find($message->wa_chat_id);

            if (! $chat instanceof WaChat || ($chat->last_message_at !== null && $chat->last_message_at->greaterThan($message->wa_timestamp))) {
                return;
            }

            $chat->forceFill(array_filter([
                'last_message_at' => $message->wa_timestamp,
                'last_message_preview' => $message->body === null ? null : Str::limit($message->body, 157),
                'last_inbound_at' => $message->isInbound() ? $message->wa_timestamp : null,
            ], static fn (mixed $value): bool => $value !== null))->save();
        });
    }

    public function inbound(): static
    {
        return $this->state(fn (): array => ['direction' => WaDirection::In, 'status' => WaMessageStatus::Received, 'sent_by_user_id' => null]);
    }

    /** An administrator's reply (a new admin when none is given), accepted by OpenWA (`sent`). */
    public function outbound(?User $admin = null): static
    {
        return $this->state(fn (): array => [
            'direction' => WaDirection::Out,
            'wa_message_id' => 'true_'.fake()->numerify('491#########').'@c.us_'.Str::upper(Str::random(20)),
            'status' => WaMessageStatus::Sent,
            'sent_by_user_id' => $admin->id ?? User::factory()->admin(),
        ]);
    }

    /** Stored, not yet handed to OpenWA (no WhatsApp id until it answers). */
    public function pending(): static
    {
        return $this->state(fn (): array => ['status' => WaMessageStatus::Pending, 'wa_message_id' => null]);
    }

    public function delivered(): static
    {
        return $this->state(fn (): array => ['status' => WaMessageStatus::Delivered]);
    }

    public function read(): static
    {
        return $this->state(fn (): array => ['status' => WaMessageStatus::Read]);
    }

    public function failed(string $error = 'The message could not be sent.'): static
    {
        return $this->state(fn (): array => ['status' => WaMessageStatus::Failed, 'error' => $error]);
    }

    /** A photo whose file is stored on the private disk. */
    public function image(?string $caption = null): static
    {
        return $this->state(fn (): array => [
            'type' => WaMessageType::Image,
            'body' => $caption,
            'media_path' => 'whatsapp/media/'.Str::lower(Str::random(26)).'.jpg',
            'media_mime' => 'image/jpeg',
            'media_filename' => 'photo.jpg',
            'media_size' => 48_213,
        ]);
    }

    /** A document recorded as a typed row: file name, mime and size, no stored file. */
    public function document(string $filename = 'invoice.pdf'): static
    {
        return $this->state(fn (): array => [
            'type' => WaMessageType::Document,
            'body' => null,
            'media_mime' => 'application/pdf',
            'media_filename' => $filename,
            'media_size' => 120_400,
        ]);
    }

    public function voice(): static
    {
        return $this->state(fn (): array => [
            'type' => WaMessageType::Voice,
            'body' => null,
            'media_mime' => 'audio/ogg; codecs=opus',
            'media_filename' => null,
            'media_size' => 9_800,
        ]);
    }
}
