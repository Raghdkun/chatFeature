<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

/**
 * A visitor text message with the next free `seq` of its conversation (whose `last_seq` is kept in step), so
 * `Message::factory()->count(3)->for($conversation)->create()` yields seq 1, 2, 3.
 *
 * @extends Factory<Message>
 */
class MessageFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'conversation_id' => Conversation::factory(),
            'seq' => fn (array $attributes): int => ((int) Message::query()->where('conversation_id', $attributes['conversation_id'])->max('seq')) + 1,
            'sender_type' => SenderType::Visitor,
            'sender_user_id' => null,
            'type' => MessageType::Text,
            'body' => fake()->sentence(),
            'client_msg_id' => null,
            'delivered_at' => null,
            'seen_at' => null,
        ];
    }

    /**
     * Messages are numbered when they are saved, so several are created one after the other
     * (`count(3)` would otherwise make all three before saving any and give them the same seq).
     *
     * @param  (callable(array<string, mixed>): array<string, mixed>)|array<string, mixed>  $attributes
     * @return Collection<int, Message>|Message
     */
    public function create($attributes = [], ?Model $parent = null)
    {
        if ($this->count === null || $this->count < 2) {
            return parent::create($attributes, $parent);
        }

        $messages = new Collection;

        for ($i = 0; $i < $this->count; $i++) {
            $message = $this->count(null)->create($attributes, $parent);
            $messages->push($message);
        }

        return $messages;
    }

    public function configure(): static
    {
        return $this->afterCreating(function (Message $message): void {
            Conversation::query()->whereKey($message->conversation_id)->where('last_seq', '<', $message->seq)->update(['last_seq' => $message->seq]);
        });
    }

    public function fromVisitor(): static
    {
        return $this->state(fn (): array => ['sender_type' => SenderType::Visitor, 'sender_user_id' => null]);
    }

    /** Written by `$agent` (a new agent when omitted). */
    public function fromAgent(?User $agent = null): static
    {
        return $this->state(fn (): array => ['sender_type' => SenderType::Agent, 'sender_user_id' => $agent->id ?? User::factory()]);
    }

    /** A server-written line such as "agent joined". */
    public function system(string $body = 'An agent joined the chat.'): static
    {
        return $this->state(fn (): array => ['sender_type' => SenderType::System, 'sender_user_id' => null, 'type' => MessageType::System, 'body' => $body]);
    }

    /** An image message with one attachment. */
    public function image(): static
    {
        return $this->state(fn (): array => ['type' => MessageType::Image, 'body' => null])
            ->afterCreating(function (Message $message): void {
                Attachment::factory()->create(['conversation_id' => $message->conversation_id, 'message_id' => $message->id]);
            });
    }

    public function withClientMsgId(?string $clientMsgId = null): static
    {
        return $this->state(fn (): array => ['client_msg_id' => $clientMsgId ?? (string) Str::ulid()]);
    }

    public function seen(): static
    {
        return $this->state(fn (): array => ['delivered_at' => now(), 'seen_at' => now()]);
    }
}
