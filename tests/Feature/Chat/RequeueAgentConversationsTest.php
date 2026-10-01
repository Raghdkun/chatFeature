<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Actions\RequeueAgentConversations;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * Decision P4-D14: a deactivated or role-revoked agent's active chats go back to the queue with fresh offers.
 */
class RequeueAgentConversationsTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $leaving;

    private User $colleague;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->leaving = $this->availableAgent($this->billing, ['name' => 'Leaving Larry']);
        $this->colleague = $this->availableAgent($this->billing, ['name' => 'Colleague Cleo']);
    }

    /**
     * @return array{live: Conversation, second: Conversation, ticket: Conversation, ended: Conversation, others: Conversation}
     */
    private function chats(): array
    {
        $make = fn (): IssuedVisitorToken => $this->visitorSession($this->widget);

        return [
            'live' => $this->activeChat($make(), $this->billing, $this->leaving),
            'second' => $this->activeChat($make(), $this->billing, $this->leaving),
            'ticket' => Conversation::factory()->offline()->active($this->leaving)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]),
            'ended' => Conversation::factory()->ended($this->leaving)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]),
            'others' => $this->activeChat($make(), $this->billing, $this->colleague),
        ];
    }

    private function revoke(SessionRevokeReason $reason): void
    {
        StaffSessionRevoked::dispatch($this->leaving->id, $reason);
    }

    public function test_a_deactivated_agents_active_chats_are_requeued_and_offered_to_the_others(): void
    {
        $chats = $this->chats();
        $this->leaving->forceFill(['is_active' => false])->save();
        Event::fake([ConversationTransferred::class, ConversationQueued::class, QueueChanged::class, ChatOffered::class]);
        // Event::fake swallows the listener too: run the action the listener runs.
        $this->assertSame(3, app(RequeueAgentConversations::class)->handle($this->leaving, 'deactivated'));

        foreach (['live', 'second'] as $name) {
            $chat = $chats[$name]->fresh();
            $this->assertSame('queued', $chat->status->value, $name);
            $this->assertNull($chat->assigned_agent_id);
            $this->assertNull($chat->claimed_at);
            $this->assertNull($chat->idle_expires_at);
            $this->assertTrue($chat->queue_expires_at->between(now()->addSeconds(85), now()->addSeconds(95)));
            $this->assertSame([$this->colleague->id], ConversationOffer::query()->where('conversation_id', $chat->id)->whereNull('response')->pluck('user_id')->all());
            $this->assertSame(OfferResponse::Dismissed, ConversationOffer::query()->where('conversation_id', $chat->id)->where('user_id', $this->leaving->id)->sole()->response);

            $event = $chat->events()->where('type', 'requeued')->sole();
            $this->assertSame('system', $event->actor_type->value);
            $this->assertSame('deactivated', $event->payload['reason']);
            $this->assertSame($this->leaving->id, $event->payload['from_agent']);
        }

        // An offline ticket waits in the queue again, with no offers (agents find it by category).
        $ticket = $chats['ticket']->fresh();
        $this->assertSame('queued', $ticket->status->value);
        $this->assertNull($ticket->assigned_agent_id);
        $this->assertNull($ticket->queue_expires_at);
        $this->assertSame(0, ConversationOffer::query()->where('conversation_id', $ticket->id)->count());

        // Finished and other agents' chats are untouched.
        $this->assertSame('ended', $chats['ended']->fresh()->status->value);
        $this->assertSame($this->leaving->id, $chats['ended']->fresh()->assigned_agent_id);
        $this->assertSame('active', $chats['others']->fresh()->status->value);

        Event::assertDispatchedTimes(ConversationTransferred::class, 3);
        Event::assertDispatched(ConversationTransferred::class, fn (ConversationTransferred $event): bool => $event->fromAgent?->is($this->leaving) && $event->toAgent === null && $event->toCategory === null);
        Event::assertDispatchedTimes(ConversationQueued::class, 3);
        Event::assertDispatchedTimes(QueueChanged::class, 3);
        Event::assertDispatchedTimes(ChatOffered::class, 2);
    }

    public function test_the_session_revoked_event_triggers_it(): void
    {
        $chats = $this->chats();
        $this->leaving->forceFill(['is_active' => false])->save();

        $this->revoke(SessionRevokeReason::Deactivated);

        $this->assertSame('queued', $chats['live']->fresh()->status->value);
        $this->assertSame('queued', $chats['ticket']->fresh()->status->value);
        $this->assertSame('active', $chats['others']->fresh()->status->value);

        // The visitor sees a chat that is waiting for an agent again.
        $token = $chats['live']->visitorSession;
        $plain = VisitorTokenService::generate();
        $token->forceFill(['token_hash' => VisitorTokenService::hash($plain)])->save();
        $this->withToken($plain)->getJson('/api/v1/public/conversation')->assertOk()->assertJsonPath('data.status', 'queued')->assertJsonPath('data.agent', null);
    }

    public function test_a_removed_role_requeues_like_a_deactivation(): void
    {
        $chats = $this->chats();
        $this->leaving->forceFill(['is_agent' => false])->save();

        $this->revoke(SessionRevokeReason::RoleRemoved);

        $this->assertSame('queued', $chats['live']->fresh()->status->value);
        $this->assertSame('queued', $chats['second']->fresh()->status->value);
        $this->assertSame('queued', $chats['ticket']->fresh()->status->value);
        $this->assertSame('role_removed', $chats['live']->events()->where('type', 'requeued')->sole()->payload['reason']);
        $this->assertSame('active', $chats['others']->fresh()->status->value);
    }

    public function test_other_reasons_and_unknown_users_do_nothing(): void
    {
        $chats = $this->chats();

        // An administrator who lost only the admin role is reported as `auth_revoked`: their chats stay.
        $this->revoke(SessionRevokeReason::AuthRevoked);
        StaffSessionRevoked::dispatch(999999, SessionRevokeReason::Deactivated);

        $this->assertSame('active', $chats['live']->fresh()->status->value);
    }

    public function test_without_anyone_else_the_chat_waits_unoffered_until_the_timeout(): void
    {
        $this->colleague->forceFill(['is_active' => false])->save();
        $chat = $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->leaving);
        $this->leaving->forceFill(['is_active' => false])->save();

        $this->revoke(SessionRevokeReason::Deactivated);

        $this->assertSame('queued', $chat->fresh()->status->value);
        $this->assertSame(0, ConversationOffer::query()->where('conversation_id', $chat->id)->whereNull('response')->count());

        $this->travel(2)->minutes();
        $this->artisan('chat:expire-queued')->assertSuccessful();
        $this->assertSame('missed', $chat->fresh()->status->value);
    }

    public function test_requeueing_twice_moves_nothing_the_second_time(): void
    {
        $this->chats();
        $this->leaving->forceFill(['is_active' => false])->save();

        $this->assertSame(3, app(RequeueAgentConversations::class)->handle($this->leaving, 'deactivated'));
        $this->assertSame(0, app(RequeueAgentConversations::class)->handle($this->leaving, 'deactivated'));
    }
}
