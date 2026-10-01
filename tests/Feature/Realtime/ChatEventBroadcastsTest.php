<?php

namespace Tests\Feature\Realtime;

use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\OfferData;
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
use App\Domain\Chat\Events\ConversationMissed;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Realtime\Broadcasts\ImmediatePayloadBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\PayloadBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\RealtimeBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Domain\Chat\Realtime\Jobs\BroadcastQueueCounts;
use App\Domain\Chat\Realtime\Listeners\ChatEventSubscriber;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use Illuminate\Broadcasting\BroadcastEvent;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\RecordingBroadcaster;
use Tests\TestCase;

/**
 * Domain event in, broadcast out: every event of docs/contracts/realtime-events.md with its channels, its name, its payload shape
 * and its delivery mode, through the real listener / broadcast event / `BroadcastEvent` job pipeline into a recording broadcaster.
 */
class ChatEventBroadcastsTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase;

    private RecordingBroadcaster $wire;

    private User $alice;

    private User $bob;

    private User $admin;

    private Category $billing;

    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->wire = $this->recordBroadcasts();

        $this->alice = User::factory()->agent()->create(['name' => 'Alice', 'display_name' => 'Alice A.']);
        $this->bob = User::factory()->agent()->create(['name' => 'Bob']);
        $this->admin = User::factory()->admin()->create();
        $this->billing = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $visitor = Visitor::factory()->create(['name' => 'Vera Visitor', 'email' => 'vera@example.test', 'phone' => '+49 30 1234', 'verified' => true]);
        $this->conversation = Conversation::factory()->forCategory($this->billing)->create(['visitor_id' => $visitor->id, 'last_message_preview' => 'Hello there']);
    }

    /**
     * @param  list<string>  $expected
     */
    private function assertChannels(string $event, array $expected): void
    {
        sort($expected);

        $this->assertSame($expected, $this->wire->channelsOf($event), "channels of {$event}");
    }

    private function staff(User $user): string
    {
        return 'private-staff.'.$user->id;
    }

    private function conversationChannel(?Conversation $conversation = null): string
    {
        return 'private-conversation.'.($conversation ?? $this->conversation)->ulid;
    }

    private function fresh(Conversation $conversation): Conversation
    {
        return Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id);
    }

    // ---- staff channels ----------------------------------------------------------------------------------------------------

    public function test_chat_offered_goes_to_every_offered_agent_in_one_publish_with_the_offer_data(): void
    {
        $inactive = User::factory()->agent()->inactive()->create();
        $expires = now()->addSeconds(90)->startOfSecond();
        $offers = new Collection([$this->alice, $this->bob, $inactive]);
        $offers = $offers->map(fn (User $agent): ConversationOffer => ConversationOffer::factory()->create([
            'conversation_id' => $this->conversation->id, 'user_id' => $agent->id, 'wave' => 2, 'expires_at' => $expires,
        ]));

        ChatOffered::dispatch($this->conversation, $offers, 2, $expires);

        $this->assertCount(1, $this->wire->of('chat.offered'));
        $this->assertChannels('chat.offered', [$this->staff($this->alice), $this->staff($this->bob)]);
        $payload = $this->wire->sole('chat.offered')['payload'];
        $this->assertSame(['v', 'conversation', 'category', 'visitor', 'preview', 'widget', 'wave', 'expiresAt'], array_keys($payload));
        $this->assertSame(1, $payload['v']);
        $this->assertSame($this->conversation->ulid, $payload['conversation']);
        $this->assertSame(['slug' => 'billing', 'label' => 'Billing'], $payload['category']);
        $this->assertSame(['name' => 'Vera Visitor', 'verified' => true], $payload['visitor']);
        $this->assertSame('Hello there', $payload['preview']);
        $this->assertSame(2, $payload['wave']);
        $this->assertSame(Timestamps::iso($expires), $payload['expiresAt']);
        $this->assertSame(['ulid', 'name'], array_keys($payload['widget']));
        $this->assertSame(json_decode(OfferData::fromModel($this->fresh($this->conversation), $offers->first())->toJson(), true), $payload, 'the spine\'s own mapping');
        $this->assertStringNotContainsString('vera@example.test', json_encode($payload));
        $this->assertStringNotContainsString('+49 30 1234', json_encode($payload));
    }

    public function test_chat_taken_tells_the_agents_who_lost_and_never_the_winner(): void
    {
        ChatTaken::dispatch($this->conversation, $this->alice, [$this->bob->id, $this->alice->id, $this->bob->id]);

        $this->assertChannels('chat.taken', [$this->staff($this->bob)]);
        $this->assertSame(
            ['v' => 1, 'conversation' => $this->conversation->ulid, 'by' => ['id' => $this->alice->id, 'name' => 'Alice A.']],
            $this->wire->sole('chat.taken')['payload'],
        );
    }

    public function test_chat_taken_with_nobody_else_offered_publishes_nothing(): void
    {
        ChatTaken::dispatch($this->conversation, $this->alice, []);
        ChatTaken::dispatch($this->conversation, $this->alice, [$this->alice->id]);

        $this->assertSame([], $this->wire->published);
    }

    public function test_an_assignment_tells_the_new_agent_and_refreshes_the_lists_of_everybody_involved(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();

        ConversationAssigned::dispatch($conversation, $this->alice, $this->admin, $this->bob);

        $this->assertChannels('chat.assigned', [$this->staff($this->alice)]);
        $this->assertSame(['v' => 1, 'conversation' => $conversation->ulid], $this->wire->sole('chat.assigned')['payload']);
        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice), $this->staff($this->bob)]);
    }

    public function test_conversation_updated_goes_to_the_assigned_agent_and_the_admins_with_the_staff_conversation(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create(['unseen_by_agent' => 3, 'last_message_preview' => 'Hi']);

        ConversationUpdated::dispatch($conversation);

        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice)]);
        $payload = $this->wire->sole('conversation.updated')['payload'];
        $this->assertSame(['v', 'conversation'], array_keys($payload));
        $this->assertSame(json_decode(ConversationStaffData::fromModel($this->fresh($conversation))->toJson(), true), $payload['conversation']);
        $this->assertSame('active', $payload['conversation']['status']);
        $this->assertSame(3, $payload['conversation']['unseenByAgent']);
        $this->assertSame(['id' => $this->alice->id, 'name' => 'Alice A.'], $payload['conversation']['assignedAgent']);
    }

    public function test_a_queued_conversation_is_refreshed_for_the_agents_holding_an_open_offer_only(): void
    {
        ConversationOffer::factory()->create(['conversation_id' => $this->conversation->id, 'user_id' => $this->alice->id]);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $this->conversation->id, 'user_id' => $this->bob->id]);

        ConversationUpdated::dispatch($this->conversation);

        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice)]);
    }

    public function test_the_payload_is_read_when_the_event_is_handled_not_when_it_was_dispatched(): void
    {
        Queue::fake();
        ConversationUpdated::dispatch($this->conversation);
        $this->conversation->forceFill(['last_message_preview' => 'changed after the dispatch'])->save();

        /** @var BroadcastEvent $job */
        $job = Queue::pushedJobs()[BroadcastEvent::class][0]['job'];
        $job->handle(app('Illuminate\Contracts\Broadcasting\Factory'));

        $this->assertSame('changed after the dispatch', $this->wire->sole('conversation.updated')['payload']['conversation']['lastMessagePreview']);
    }

    public function test_a_conversation_that_is_gone_by_the_time_the_worker_runs_is_not_broadcast(): void
    {
        Queue::fake();
        ConversationUpdated::dispatch($this->conversation);
        Conversation::query()->whereKey($this->conversation->id)->delete();

        /** @var BroadcastEvent $job */
        $job = Queue::pushedJobs()[BroadcastEvent::class][0]['job'];
        $job->handle(app('Illuminate\Contracts\Broadcasting\Factory'));

        $this->assertSame([], $this->wire->published);
    }

    public function test_unread_updated_carries_the_absolute_counter_to_the_assigned_agent(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create(['unseen_by_agent' => 4]);

        UnseenCountChanged::dispatch($conversation);

        $this->assertChannels('unread.updated', [$this->staff($this->alice)]);
        $this->assertSame(['v' => 1, 'conversation' => $conversation->ulid, 'unseen' => 4], $this->wire->sole('unread.updated')['payload']);
    }

    public function test_unread_updated_without_an_assigned_agent_publishes_nothing(): void
    {
        UnseenCountChanged::dispatch($this->conversation);

        $this->assertSame([], $this->wire->of('unread.updated'));
    }

    public function test_presence_changes_go_to_the_roster(): void
    {
        PresenceChanged::dispatch($this->alice->id, PresenceStatus::Away);

        $this->assertSame(['presence-staff'], $this->wire->sole('presence.changed')['channels']);
        $this->assertSame(['v' => 1, 'userId' => $this->alice->id, 'status' => 'away'], $this->wire->sole('presence.changed')['payload']);
    }

    public function test_a_revoked_session_tells_that_staff_channel(): void
    {
        StaffSessionRevoked::dispatch($this->alice->id, SessionRevokeReason::RoleRemoved);

        $this->assertSame([$this->staff($this->alice)], $this->wire->sole('session.revoked')['channels']);
        $this->assertSame(['v' => 1, 'reason' => 'role_removed'], $this->wire->sole('session.revoked')['payload']);
    }

    public function test_every_revocation_reason_reaches_the_client_by_its_contract_name(): void
    {
        foreach (SessionRevokeReason::cases() as $reason) {
            StaffSessionRevoked::dispatch($this->alice->id, $reason);
        }

        $this->assertSame(['role_removed', 'deactivated', 'auth_revoked'], array_column(array_column($this->wire->of('session.revoked'), 'payload'), 'reason'));
    }

    // ---- admin channel -----------------------------------------------------------------------------------------------------

    public function test_an_offline_ticket_goes_to_the_admins_and_refreshes_the_lists_of_the_category_servers(): void
    {
        $this->alice->categories()->attach($this->billing->id);
        $ticket = Conversation::factory()->offline()->forCategory($this->billing)->create();

        OfflineTicketCreated::dispatch($ticket);

        $this->assertChannels('offline-ticket.created', ['private-admin']);
        $payload = $this->wire->sole('offline-ticket.created')['payload'];
        $this->assertSame(['v', 'conversation'], array_keys($payload));
        $this->assertSame($ticket->ulid, $payload['conversation']['ulid']);
        $this->assertSame('offline', $payload['conversation']['type']);
        // The agents who serve the category see the ticket through the list refresh; the admin has the dedicated event.
        $this->assertChannels('conversation.updated', [$this->staff($this->alice)]);
    }

    public function test_a_rating_goes_to_the_admins_only(): void
    {
        $rating = Rating::factory()->create(['conversation_id' => $this->conversation->id, 'score' => 4, 'comment' => 'secret comment']);

        ConversationRated::dispatch($this->conversation, $rating);

        $this->assertChannels('conversation.rated', ['private-admin']);
        $this->assertSame(['v' => 1, 'conversation' => $this->conversation->ulid, 'score' => 4], $this->wire->sole('conversation.rated')['payload']);
    }

    // ---- conversation channel ----------------------------------------------------------------------------------------------

    public function test_claiming_tells_the_visitor_and_refreshes_the_claimers_list(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();

        ConversationClaimed::dispatch($conversation, $this->alice);

        $this->assertChannels('chat.claimed', [$this->conversationChannel($conversation)]);
        $this->assertSame(
            ['v' => 1, 'agent' => ['name' => 'Alice A.', 'avatarUrl' => null], 'claimedAt' => Timestamps::iso($conversation->claimed_at)],
            $this->wire->sole('chat.claimed')['payload'],
        );
        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice)]);
    }

    public function test_a_claim_event_with_a_stale_model_still_carries_the_real_claim_time(): void
    {
        $claimed = Conversation::factory()->active($this->alice)->create();
        $stale = Conversation::query()->findOrFail($claimed->id);
        $stale->claimed_at = null;

        ConversationClaimed::dispatch($stale, $this->alice);

        $this->assertSame(Timestamps::iso($claimed->claimed_at), $this->wire->sole('chat.claimed')['payload']['claimedAt']);
    }

    public function test_message_created_publishes_the_visitor_safe_message_on_the_shared_channel(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $message = Message::factory()->for($conversation)->fromAgent($this->alice)->withClientMsgId('c-1')->create(['body' => 'Hi, how can I help?']);

        MessageCreated::dispatch($message);

        $this->assertChannels('message.created', [$this->conversationChannel($conversation)]);
        $payload = $this->wire->sole('message.created')['payload'];
        $this->assertSame(['v', 'message'], array_keys($payload));
        $this->assertSame(
            ['ulid', 'seq', 'conversation', 'sender', 'type', 'body', 'attachments', 'clientMsgId', 'createdAt', 'deliveredAt', 'seenAt'],
            array_keys($payload['message']),
        );
        $this->assertSame(['type' => 'agent', 'name' => 'Alice A.', 'avatarUrl' => null], $payload['message']['sender'], 'no staff id on the shared channel');
        $this->assertSame(1, $payload['message']['seq']);
        $this->assertSame($conversation->ulid, $payload['message']['conversation']);
        $this->assertSame('c-1', $payload['message']['clientMsgId']);
        $this->assertSame('Hi, how can I help?', $payload['message']['body']);
    }

    public function test_message_created_carries_signed_attachment_urls_and_nothing_about_storage(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $message = Message::factory()->for($conversation)->image()->create();

        MessageCreated::dispatch($message);

        $attachment = $this->wire->sole('message.created')['payload']['message']['attachments'][0];
        $this->assertSame(['ulid', 'mime', 'size', 'width', 'height', 'url', 'thumbUrl'], array_keys($attachment));
        $this->assertStringContainsString('signature=', $attachment['url']);
        $this->assertStringNotContainsString('chat/attachments', json_encode($attachment));
        $this->assertStringNotContainsString('screenshot.png', json_encode($attachment));
    }

    public function test_a_visitor_message_names_the_visitor_without_ids(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $message = Message::factory()->for($conversation)->create(['body' => 'Help']);

        MessageCreated::dispatch($message);

        $this->assertSame(['type' => 'visitor', 'name' => $conversation->visitor->name, 'avatarUrl' => null], $this->wire->sole('message.created')['payload']['message']['sender']);
    }

    public function test_message_seen_names_who_read_up_to_where(): void
    {
        MessagesSeen::dispatch($this->conversation, 7, SenderType::Agent);

        $this->assertChannels('message.seen', [$this->conversationChannel()]);
        $payload = $this->wire->sole('message.seen')['payload'];
        $this->assertSame(['v', 'upToSeq', 'by', 'at'], array_keys($payload));
        $this->assertSame([1, 7, 'agent'], [$payload['v'], $payload['upToSeq'], $payload['by']]);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $payload['at']);
    }

    public function test_message_seen_by_the_system_is_not_a_receipt(): void
    {
        MessagesSeen::dispatch($this->conversation, 7, SenderType::System);

        $this->assertSame([], $this->wire->published);
    }

    public function test_ending_a_chat_tells_the_visitor_whether_a_rating_is_asked_and_refreshes_the_lists(): void
    {
        $conversation = Conversation::factory()->ended($this->alice)->create();

        ConversationEnded::dispatch($conversation, ConversationEndedBy::Agent);

        $this->assertChannels('conversation.ended', [$this->conversationChannel($conversation)]);
        $this->assertSame(['v' => 1, 'endedBy' => 'agent', 'ratingRequested' => true], $this->wire->sole('conversation.ended')['payload']);
        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice)]);
    }

    public function test_the_rating_request_is_read_from_the_database_when_the_model_is_stale(): void
    {
        $conversation = Conversation::factory()->ended($this->alice)->create();
        $stale = Conversation::query()->findOrFail($conversation->id);
        $stale->rating_requested = false;

        ConversationEnded::dispatch($stale, ConversationEndedBy::Visitor);

        $this->assertTrue($this->wire->sole('conversation.ended')['payload']['ratingRequested']);
    }

    public function test_closing_names_the_reason_on_the_conversation_channel(): void
    {
        $conversation = Conversation::factory()->closed($this->alice, ConversationCloseReason::Idle)->create();

        ConversationClosed::dispatch($conversation, ConversationCloseReason::Idle);

        $this->assertChannels('conversation.closed', [$this->conversationChannel($conversation)]);
        $this->assertSame(['v' => 1, 'reason' => 'idle'], $this->wire->sole('conversation.closed')['payload']);
        $this->assertChannels('conversation.updated', ['private-admin', $this->staff($this->alice)]);
    }

    public function test_a_missed_chat_tells_the_waiting_visitor_on_the_conversation_channel(): void
    {
        $conversation = Conversation::factory()->create(['category_id' => $this->billing->id]);

        ConversationMissed::dispatch($conversation);

        $this->assertChannels('conversation.missed', [$this->conversationChannel($conversation)]);
        $this->assertSame(['v' => 1], $this->wire->sole('conversation.missed')['payload']);
    }

    public function test_a_transfer_tells_the_visitor_and_refreshes_the_list_of_the_agent_the_chat_left(): void
    {
        $conversation = Conversation::factory()->create(['category_id' => $this->billing->id]);

        ConversationTransferred::dispatch($conversation, $this->alice, null, $this->billing);

        $this->assertChannels('conversation.transferred', [$this->conversationChannel($conversation)]);
        $this->assertSame(['v' => 1], $this->wire->sole('conversation.transferred')['payload']);
        $this->assertContains($this->staff($this->alice), $this->wire->channelsOf('conversation.updated'));
        $this->assertContains('private-admin', $this->wire->channelsOf('conversation.updated'));
    }

    public function test_queueing_refreshes_the_admin_list_and_counts_the_queue(): void
    {
        ConversationQueued::dispatch($this->conversation);

        $this->assertChannels('conversation.updated', ['private-admin']);
        $this->assertNotEmpty($this->wire->of('queue.updated'));
    }

    // ---- delivery ----------------------------------------------------------------------------------------------------------

    public function test_the_latency_sensitive_events_are_published_immediately_and_the_rest_is_queued(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $message = Message::factory()->for($conversation)->create();
        Queue::fake();

        MessageCreated::dispatch($message);
        ConversationClaimed::dispatch($conversation, $this->alice);
        // A user without chats: a revoked agent's open chats would be requeued (4A's listener) and queue more broadcasts.
        StaffSessionRevoked::dispatch(999_999, SessionRevokeReason::Deactivated);
        TypingBroadcast::dispatch($conversation->ulid, SenderType::Visitor, true);

        foreach (['message.created', 'chat.claimed', 'session.revoked', 'typing'] as $event) {
            $this->assertCount(1, $this->wire->of($event), "{$event} is published at once");
        }

        // What was queued: the list refresh of the claim, not the latency-sensitive events.
        $queued = array_map(fn (array $entry): object => $entry['job']->event, Queue::pushedJobs()[BroadcastEvent::class]);
        $this->assertCount(1, $queued);
        $this->assertSame('conversation.updated', $queued[0]->broadcastAs());
    }

    public function test_the_fact_events_are_queued(): void
    {
        Queue::fake();

        ChatTaken::dispatch($this->conversation, $this->alice, [$this->bob->id]);
        MessagesSeen::dispatch($this->conversation, 3, SenderType::Visitor);
        ConversationEnded::dispatch($this->conversation, ConversationEndedBy::System);
        ConversationClosed::dispatch($this->conversation, ConversationCloseReason::Skipped);
        ConversationTransferred::dispatch($this->conversation, null, null, null);
        ConversationRated::dispatch($this->conversation, Rating::factory()->create(['conversation_id' => $this->conversation->id]));
        PresenceChanged::dispatch($this->alice->id, PresenceStatus::Online);
        UnseenCountChanged::dispatch($this->conversation);
        OfflineTicketCreated::dispatch($this->conversation);

        $this->assertSame([], $this->wire->published, 'nothing was published inside the dispatching process');
        $queuedEvents = array_map(fn (array $entry): string => $entry['job']->event->broadcastAs(), Queue::pushedJobs()[BroadcastEvent::class]);
        foreach (['chat.taken', 'message.seen', 'conversation.ended', 'conversation.closed', 'conversation.transferred', 'conversation.rated', 'presence.changed', 'unread.updated', 'offline-ticket.created', 'conversation.updated'] as $event) {
            $this->assertContains($event, $queuedEvents);
        }
    }

    public function test_the_immediate_events_implement_should_broadcast_now_and_the_queued_ones_do_not(): void
    {
        $immediate = new ImmediatePayloadBroadcast(RealtimeEvent::MessageCreated, [], []);
        $queued = new PayloadBroadcast(RealtimeEvent::MessageSeen, [], []);

        $this->assertInstanceOf(ShouldBroadcastNow::class, $immediate);
        $this->assertNotInstanceOf(ShouldBroadcastNow::class, $queued);
        $this->assertInstanceOf(RealtimeBroadcast::class, $queued);
    }

    public function test_queued_broadcasts_use_the_configured_queue_and_fall_back_to_the_default(): void
    {
        Queue::fake();
        ConversationUpdated::dispatch($this->conversation);
        Queue::assertPushed(BroadcastEvent::class, fn (BroadcastEvent $job, ?string $queue): bool => $queue === null);

        Queue::fake();
        config(['broadcasting.realtime.queue' => 'broadcasts']);
        ConversationUpdated::dispatch($this->conversation);
        QueueChanged::dispatch();
        Queue::assertPushedOn('broadcasts', BroadcastEvent::class);
        Queue::assertPushedOn('broadcasts', BroadcastQueueCounts::class);
    }

    public function test_a_queued_broadcast_is_retried_briefly_and_then_dropped(): void
    {
        $broadcast = new PayloadBroadcast(RealtimeEvent::MessageSeen, [], []);
        $job = new BroadcastEvent($broadcast);

        $this->assertSame(3, $job->tries);
        $this->assertSame(1, $job->backoff);
        $this->assertSame(10, $job->timeout);
    }

    // ---- completeness ------------------------------------------------------------------------------------------------------

    public function test_the_subscriber_listens_to_every_domain_event_of_the_chat_context(): void
    {
        $subscribed = array_keys((new ChatEventSubscriber)->subscribe(app('events')));
        $declared = array_map(
            fn (string $path): string => 'App\\Domain\\Chat\\Events\\'.basename($path, '.php'),
            glob(app_path('Domain/Chat/Events/*.php')) ?: [],
        );

        $this->assertEqualsCanonicalizing($declared, $subscribed);

        foreach ($subscribed as $event) {
            $this->assertNotEmpty(app('events')->getListeners($event), "{$event} has a listener");
        }
    }

    public function test_the_whole_lifecycle_produces_every_event_of_the_contract(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $offer = ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $this->bob->id]);
        $message = Message::factory()->for($conversation)->create();
        $rating = Rating::factory()->create(['conversation_id' => $conversation->id]);

        ConversationQueued::dispatch($conversation);
        ChatOffered::dispatch($conversation, new Collection([$offer]), 1, now()->addMinute());
        ChatTaken::dispatch($conversation, $this->alice, [$this->bob->id]);
        ConversationClaimed::dispatch($conversation, $this->alice);
        ConversationAssigned::dispatch($conversation, $this->alice, $this->admin, $this->bob);
        ConversationUpdated::dispatch($conversation);
        MessageCreated::dispatch($message);
        MessagesSeen::dispatch($conversation, 1, SenderType::Agent);
        ConversationEnded::dispatch($conversation, ConversationEndedBy::Agent);
        ConversationClosed::dispatch($conversation, ConversationCloseReason::Rated);
        ConversationMissed::dispatch($conversation);
        ConversationTransferred::dispatch($conversation, $this->alice, $this->bob, null);
        OfflineTicketCreated::dispatch($conversation);
        ConversationRated::dispatch($conversation, $rating);
        UnseenCountChanged::dispatch($conversation);
        QueueChanged::dispatch($conversation);
        PresenceChanged::dispatch($this->alice->id, PresenceStatus::Online);
        StaffSessionRevoked::dispatch($this->alice->id, SessionRevokeReason::Deactivated);
        TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, false);

        $published = array_values(array_unique(array_column($this->wire->published, 'event')));
        $contract = array_map(fn (RealtimeEvent $event): string => $event->value, RealtimeEvent::cases());

        $this->assertEqualsCanonicalizing($contract, $published);
    }

    public function test_every_payload_of_the_lifecycle_starts_with_the_version(): void
    {
        $conversation = Conversation::factory()->active($this->alice)->create();
        $message = Message::factory()->for($conversation)->create();

        ConversationUpdated::dispatch($conversation);
        MessageCreated::dispatch($message);
        MessagesSeen::dispatch($conversation, 1, SenderType::Agent);
        ConversationEnded::dispatch($conversation, ConversationEndedBy::Agent);
        UnseenCountChanged::dispatch($conversation);
        QueueChanged::dispatch();
        PresenceChanged::dispatch($this->alice->id, PresenceStatus::Online);
        TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, true);

        $this->assertNotEmpty($this->wire->published);

        foreach ($this->wire->published as $entry) {
            $this->assertSame('v', array_key_first($entry['payload']), $entry['event']);
            $this->assertSame(1, $entry['payload']['v'], $entry['event']);
        }
    }

    public function test_the_event_names_are_the_dotted_names_of_the_contract(): void
    {
        $this->assertSame(
            ['chat.offered', 'chat.taken', 'chat.assigned', 'chat.claimed', 'conversation.updated', 'unread.updated', 'queue.updated', 'session.revoked', 'presence.changed', 'message.created', 'message.seen', 'conversation.ended', 'conversation.closed', 'conversation.missed', 'conversation.transferred', 'offline-ticket.created', 'conversation.rated', 'typing'],
            array_map(fn (RealtimeEvent $event): string => $event->value, RealtimeEvent::cases()),
        );
    }
}
