<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesDelivered;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\RecordingBroadcaster;
use Tests\TestCase;

/**
 * What a visitor can see on `private-conversation.{ulid}` is public by construction: no integer ids, no staff e-mail, no staff-only
 * fields, and no staff event ever lands on that channel. Staff payloads never carry secrets either.
 */
class RealtimePrivacyTest extends TestCase
{
    use AssertsPublicPayloads, InteractsWithRealtime, RefreshDatabase;

    /** Keys that only staff payloads may carry. */
    private const STAFF_ONLY_KEYS = ['id', 'userId', 'user_id', 'email', 'phone', 'meta', 'unseen', 'unseenByAgent', 'unseenByVisitor', 'assignedAgent', 'visitor', 'widget', 'lastMessagePreview', 'claimedAt_by', 'path', 'thumb_path', 'disk', 'sha256', 'originalName', 'original_name', 'token', 'token_hash'];

    private RecordingBroadcaster $wire;

    private User $agent;

    private Visitor $visitor;

    protected function setUp(): void
    {
        parent::setUp();

        $this->wire = $this->recordBroadcasts();
        $this->agent = User::factory()->agent()->create(['name' => 'Alice', 'email' => 'alice.agent@staff.example']);
        $this->visitor = Visitor::factory()->verified('cust-77')->create(['name' => 'Vera', 'email' => 'vera@customer.example', 'phone' => '+49 30 555 0101', 'meta' => ['plan' => 'gold']]);
    }

    /** Dispatch every domain event for one conversation that has an agent, messages, an attachment and a rating. */
    private function runTheWholeLifecycle(): void
    {
        $category = Category::factory()->create();
        $this->agent->categories()->attach($category->id);
        $conversation = Conversation::factory()->active($this->agent)->forCategory($category)->create(['visitor_id' => $this->visitor->id, 'unseen_by_agent' => 2]);
        $offer = ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $this->agent->id]);
        $fromVisitor = Message::factory()->for($conversation)->create(['body' => 'Hello']);
        $fromAgent = Message::factory()->for($conversation)->fromAgent($this->agent)->create(['body' => 'Hi Vera']);
        $withImage = Message::factory()->for($conversation)->fromAgent($this->agent)->image()->create();
        $system = Message::factory()->for($conversation)->system()->create();
        $rating = Rating::factory()->create(['conversation_id' => $conversation->id, 'comment' => 'internal only']);
        $other = User::factory()->agent()->create();

        ConversationQueued::dispatch($conversation);
        ChatOffered::dispatch($conversation, new Collection([$offer]), 1, now()->addMinute());
        ChatTaken::dispatch($conversation, $this->agent, [$other->id]);
        ConversationClaimed::dispatch($conversation, $this->agent);
        ConversationAssigned::dispatch($conversation, $this->agent, null, $other);
        ConversationUpdated::dispatch($conversation);
        foreach ([$fromVisitor, $fromAgent, $withImage, $system] as $message) {
            MessageCreated::dispatch($message);
        }
        MessagesDelivered::dispatch($conversation, 4, SenderType::Visitor);
        MessagesDelivered::dispatch($conversation, 4, SenderType::Agent);
        MessagesSeen::dispatch($conversation, 4, SenderType::Visitor);
        MessagesSeen::dispatch($conversation, 4, SenderType::Agent);
        UnseenCountChanged::dispatch($conversation);
        TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, true);
        ConversationEnded::dispatch($conversation, ConversationEndedBy::Agent);
        ConversationTransferred::dispatch($conversation, $this->agent, $other, $category);
        ConversationClosed::dispatch($conversation, ConversationCloseReason::Rated);
        ConversationRated::dispatch($conversation, $rating);
        OfflineTicketCreated::dispatch($conversation);
        QueueChanged::dispatch($conversation);
        PresenceChanged::dispatch($this->agent->id, PresenceStatus::Online);
        StaffSessionRevoked::dispatch($this->agent->id, SessionRevokeReason::Deactivated);
    }

    /**
     * @return list<array{channels: list<string>, event: string, payload: array<string, mixed>}>
     */
    private function publishedOnConversationChannels(): array
    {
        return array_values(array_filter(
            $this->wire->published,
            fn (array $entry): bool => $this->touchesAConversationChannel($entry['channels']),
        ));
    }

    /**
     * @param  list<string>  $channels
     */
    private function touchesAConversationChannel(array $channels): bool
    {
        foreach ($channels as $channel) {
            if (str_starts_with($channel, 'private-conversation.')) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<array-key, mixed>  $payload
     * @return list<string>
     */
    private function keysOf(array $payload): array
    {
        $keys = [];

        foreach ($payload as $key => $value) {
            if (is_string($key)) {
                $keys[] = $key;
            }

            if (is_array($value)) {
                array_push($keys, ...$this->keysOf($value));
            }
        }

        return $keys;
    }

    public function test_only_visitor_safe_events_are_published_on_a_conversation_channel(): void
    {
        $this->runTheWholeLifecycle();

        $events = array_values(array_unique(array_column($this->publishedOnConversationChannels(), 'event')));
        sort($events);

        $this->assertSame(
            ['chat.claimed', 'conversation.closed', 'conversation.ended', 'conversation.transferred', 'message.created', 'message.delivered', 'message.seen', 'typing'],
            $events,
        );

        foreach ($this->publishedOnConversationChannels() as $entry) {
            $this->assertSame(
                array_values(array_filter($entry['channels'], fn (string $channel): bool => str_starts_with($channel, 'private-conversation.'))),
                $entry['channels'],
                "{$entry['event']} is never mixed with staff channels",
            );
        }
    }

    public function test_nothing_a_visitor_can_read_carries_an_integer_id_a_staff_email_or_a_staff_only_field(): void
    {
        $this->runTheWholeLifecycle();
        $entries = $this->publishedOnConversationChannels();
        $this->assertNotEmpty($entries);

        foreach ($entries as $entry) {
            $json = json_encode($entry['payload'], JSON_THROW_ON_ERROR);

            $this->assertNoIntegerIds($entry['payload']);
            $this->assertStringNotContainsString('alice.agent@staff.example', $json, "{$entry['event']} leaks the agent's e-mail");
            $this->assertStringNotContainsString('vera@customer.example', $json, "{$entry['event']} leaks the visitor's e-mail");
            $this->assertStringNotContainsString('+49 30 555 0101', $json);
            $this->assertStringNotContainsString('internal only', $json, 'the rating comment is admin-only');
            $this->assertStringNotContainsString('cust-77', $json, 'the host site\'s external id stays server side');

            foreach ($this->keysOf($entry['payload']) as $key) {
                $this->assertNotContains($key, self::STAFF_ONLY_KEYS, "{$entry['event']} carries the staff-only key [{$key}]");
            }
        }
    }

    public function test_an_agent_appears_to_visitors_as_a_name_and_an_avatar_only(): void
    {
        $this->runTheWholeLifecycle();

        $claimed = $this->wire->sole('chat.claimed')['payload'];
        $this->assertSame(['name' => 'Alice', 'avatarUrl' => null], $claimed['agent']);

        $senders = array_map(fn (array $entry): array => $entry['payload']['message']['sender'], $this->wire->of('message.created'));
        foreach ($senders as $sender) {
            $this->assertNotContains('id', array_keys($sender));
            $this->assertContains(array_keys($sender), [['type', 'name', 'avatarUrl']]);
        }
    }

    public function test_the_staff_only_events_never_go_anywhere_but_staff_channels(): void
    {
        $this->runTheWholeLifecycle();

        foreach (['chat.offered', 'chat.taken', 'chat.assigned', 'conversation.updated', 'unread.updated', 'queue.updated', 'session.revoked', 'offline-ticket.created', 'conversation.rated'] as $event) {
            $this->assertNotEmpty($this->wire->of($event), "{$event} was published");

            foreach ($this->wire->of($event) as $entry) {
                foreach ($entry['channels'] as $channel) {
                    $this->assertMatchesRegularExpression('/^private-(staff\.\d+|admin)$/', $channel, "{$event} -> {$channel}");
                }
            }
        }

        $this->assertSame(['presence-staff'], $this->wire->sole('presence.changed')['channels']);
    }

    public function test_no_payload_anywhere_carries_a_secret_or_a_staff_email(): void
    {
        $this->runTheWholeLifecycle();

        foreach ($this->wire->published as $entry) {
            $json = json_encode($entry['payload'], JSON_THROW_ON_ERROR);

            foreach (['alice.agent@staff.example', 'password', 'remember_token', 'two_factor', 'token_hash', 'identity_secret'] as $needle) {
                $this->assertStringNotContainsString($needle, $json, "{$entry['event']} contains [{$needle}]");
            }
        }
    }

    public function test_the_staff_conversation_keeps_its_contact_details_for_staff_channels_only(): void
    {
        $this->runTheWholeLifecycle();

        $updated = $this->wire->of('conversation.updated')[0]['payload']['conversation'];

        $this->assertSame('vera@customer.example', $updated['visitor']['email']);
        $this->assertSame(['plan' => 'gold'], $updated['visitor']['meta']);
        $this->assertSame([], array_filter($this->wire->of('conversation.updated'), fn (array $entry): bool => $this->touchesAConversationChannel($entry['channels'])));
    }

    public function test_the_typing_fallback_carries_only_the_actor_and_the_flag(): void
    {
        $conversation = Conversation::factory()->active($this->agent)->create();

        TypingBroadcast::dispatch($conversation->ulid, SenderType::Visitor, true);
        TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, false);

        $entries = $this->wire->of('typing');
        $this->assertSame(['private-conversation.'.$conversation->ulid], $entries[0]['channels']);
        $this->assertSame(['v' => 1, 'actor' => 'visitor', 'typing' => true], $entries[0]['payload']);
        $this->assertSame(['v' => 1, 'actor' => 'agent', 'typing' => false], $entries[1]['payload']);
    }

    public function test_the_system_is_not_a_typist(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        new TypingBroadcast('01JZZZZZZZZZZZZZZZZZZZZZZZ', SenderType::System, true);
    }
}
