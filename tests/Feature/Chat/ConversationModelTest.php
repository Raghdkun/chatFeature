<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\AgentPresence;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationEvent;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use Carbon\CarbonInterface;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ConversationModelTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_conversation_gets_a_unique_human_ticket_number(): void
    {
        $tickets = Conversation::factory()->count(25)->create()->pluck('ticket_no');

        $this->assertCount(25, $tickets->unique());

        foreach ($tickets as $ticket) {
            $this->assertMatchesRegularExpression('/^[A-Z2-9]{6}$/D', $ticket);
        }
    }

    public function test_an_explicit_ticket_number_is_kept(): void
    {
        $this->assertSame('K7M2QX', Conversation::factory()->create(['ticket_no' => 'K7M2QX'])->ticket_no);
    }

    public function test_a_fresh_model_carries_the_column_defaults_before_it_is_reloaded(): void
    {
        $conversation = new Conversation;

        $this->assertSame(ConversationType::Live, $conversation->type);
        $this->assertSame(ConversationStatus::Queued, $conversation->status);
        $this->assertSame(0, $conversation->last_seq);
        $this->assertSame(0, $conversation->claim_version);
        $this->assertFalse($conversation->rating_requested);
    }

    public function test_attributes_are_cast(): void
    {
        $conversation = Conversation::factory()->closed(null, ConversationCloseReason::Rated)->create()->fresh();

        $this->assertInstanceOf(Conversation::class, $conversation);
        $this->assertSame(ConversationStatus::Closed, $conversation->status);
        $this->assertSame(ConversationEndedBy::Agent, $conversation->ended_by);
        $this->assertSame(ConversationCloseReason::Rated, $conversation->close_reason);
        $this->assertInstanceOf(CarbonInterface::class, $conversation->closed_at);
        $this->assertIsInt($conversation->assigned_agent_id);
        $this->assertTrue($conversation->rating_requested);
    }

    public function test_the_route_key_is_the_ulid(): void
    {
        $conversation = Conversation::factory()->create();

        $this->assertSame('ulid', $conversation->getRouteKeyName());
        $this->assertSame(26, strlen($conversation->ulid));
        $this->assertNotSame((string) $conversation->id, $conversation->ulid);
    }

    public function test_the_relationships_are_wired(): void
    {
        $agent = User::factory()->create();
        $category = Category::factory()->create();
        $conversation = Conversation::factory()->active($agent)->forCategory($category)->create();
        $first = Message::factory()->for($conversation)->create();
        $second = Message::factory()->for($conversation)->fromAgent($agent)->create();
        Attachment::factory()->create(['conversation_id' => $conversation->id, 'message_id' => $first->id]);
        ConversationEvent::factory()->create(['conversation_id' => $conversation->id]);
        ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $agent->id]);
        Rating::factory()->create(['conversation_id' => $conversation->id]);

        $this->assertInstanceOf(Widget::class, $conversation->widget);
        $this->assertInstanceOf(Visitor::class, $conversation->visitor);
        $this->assertInstanceOf(VisitorSession::class, $conversation->visitorSession);
        $this->assertTrue($conversation->category?->is($category));
        $this->assertTrue($conversation->assignedAgent?->is($agent));
        $this->assertSame([$first->id, $second->id], $conversation->messages->pluck('id')->all());
        $this->assertCount(1, $conversation->events);
        $this->assertCount(1, $conversation->offers);
        $this->assertCount(1, $conversation->attachments);
        $this->assertInstanceOf(Rating::class, $conversation->rating);
        $this->assertSame($conversation->widget_id, $conversation->visitor->widget_id);
        $this->assertSame($conversation->visitor_id, $conversation->visitorSession?->visitor_id);

        $this->assertTrue($agent->assignedConversations->first()?->is($conversation));
        $this->assertCount(1, $agent->conversationOffers);
        $this->assertTrue($conversation->widget->conversations->first()?->is($conversation));
        $this->assertTrue($conversation->widget->visitors->first()?->is($conversation->visitor));
        $this->assertTrue($category->conversations->first()?->is($conversation));
        $this->assertTrue($conversation->visitor->conversations->first()?->is($conversation));
        $this->assertTrue($conversation->visitorSession?->conversations->first()?->is($conversation));
        $this->assertTrue($first->attachments->first()?->conversation->is($conversation));
        $this->assertTrue($second->senderUser?->is($agent));
    }

    public function test_a_user_has_one_presence_row_and_the_categories_they_serve(): void
    {
        $agent = User::factory()->create();
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);
        $presence = AgentPresence::factory()->online()->create(['user_id' => $agent->id]);

        $this->assertTrue($agent->presence?->is($presence));
        $this->assertSame(PresenceStatus::Online, $agent->presence->status);
        $this->assertSame([$category->id], $agent->categories->pluck('id')->all());
    }

    public function test_a_conversation_keeps_its_widget_and_category_after_they_are_soft_deleted(): void
    {
        $category = Category::factory()->create();
        $conversation = Conversation::factory()->forCategory($category)->create();

        $conversation->widget->delete();
        $category->delete();
        $conversation = Conversation::query()->findOrFail($conversation->id);

        $this->assertNotNull($conversation->widget);
        $this->assertNotNull($conversation->category);
    }

    public function test_open_means_queued_or_active(): void
    {
        $queued = Conversation::factory()->create();
        $active = Conversation::factory()->active()->create();
        Conversation::factory()->ended()->create();
        Conversation::factory()->closed()->create();
        Conversation::factory()->missed()->create();

        $this->assertEqualsCanonicalizing([$queued->id, $active->id], Conversation::query()->open()->pluck('id')->all());
        $this->assertTrue($queued->isOpen());
        $this->assertTrue($active->isOpen());
        $this->assertFalse(Conversation::factory()->closed()->create()->isOpen());
    }

    public function test_offline_tickets_never_end_or_miss(): void
    {
        $offline = Conversation::factory()->offline()->create();
        $live = Conversation::factory()->create();

        $this->assertTrue($offline->isOffline());
        $this->assertFalse($offline->isLive());
        $this->assertTrue($live->isLive());

        $this->assertTrue($offline->canTransitionTo(ConversationStatus::Active));
        $this->assertTrue($offline->canTransitionTo(ConversationStatus::Closed));
        $this->assertFalse($offline->canTransitionTo(ConversationStatus::Missed));
        $this->assertTrue($live->canTransitionTo(ConversationStatus::Missed));

        $activeOffline = Conversation::factory()->offline()->active()->create();
        $this->assertFalse($activeOffline->canTransitionTo(ConversationStatus::Ended));
        $this->assertTrue($activeOffline->canTransitionTo(ConversationStatus::Queued));
        $this->assertTrue(Conversation::factory()->active()->create()->canTransitionTo(ConversationStatus::Ended));
    }

    public function test_the_model_follows_the_status_table(): void
    {
        $closed = Conversation::factory()->closed()->create();

        foreach (ConversationStatus::cases() as $to) {
            $this->assertFalse($closed->canTransitionTo($to), $to->value);
        }
    }

    public function test_an_offer_is_open_until_it_is_answered_or_expires(): void
    {
        $open = ConversationOffer::factory()->create();
        $expired = ConversationOffer::factory()->expired()->create();
        $accepted = ConversationOffer::factory()->answered(OfferResponse::Accepted)->create();
        $taken = ConversationOffer::factory()->answered(OfferResponse::Taken)->create();

        $this->assertSame([$open->id], ConversationOffer::query()->open()->pluck('id')->all());
        $this->assertTrue($open->isOpen());
        $this->assertFalse($expired->isOpen());
        $this->assertFalse($accepted->isOpen());
        $this->assertFalse($taken->isOpen());
        $this->assertTrue($open->conversation->isOfferedTo($open->user));
        $this->assertFalse($expired->conversation->isOfferedTo($expired->user));
        $this->assertFalse($open->conversation->isOfferedTo(User::factory()->create()));
    }

    public function test_the_conversation_and_user_of_an_offer_load(): void
    {
        $offer = ConversationOffer::factory()->create();

        $this->assertInstanceOf(Conversation::class, $offer->conversation);
        $this->assertInstanceOf(User::class, $offer->user);
        $this->assertSame('conversation_agent_alerts', $offer->getTable());
    }

    public function test_visible_to_gives_each_kind_of_user_exactly_their_conversations(): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->create();
        $colleague = User::factory()->create();
        $stranger = User::factory()->create();
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);

        $mine = Conversation::factory()->active($agent)->create();
        $mineEnded = Conversation::factory()->ended($agent)->create();
        $theirs = Conversation::factory()->active($colleague)->create();
        $offered = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offered->id, 'user_id' => $agent->id]);
        $offeredToColleague = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offeredToColleague->id, 'user_id' => $colleague->id]);
        $expiredOffer = Conversation::factory()->create();
        ConversationOffer::factory()->expired()->create(['conversation_id' => $expiredOffer->id, 'user_id' => $agent->id]);
        $answeredOffer = Conversation::factory()->create();
        ConversationOffer::factory()->answered(OfferResponse::Taken)->create(['conversation_id' => $answeredOffer->id, 'user_id' => $agent->id]);
        $offeredButClaimedByOther = Conversation::factory()->active($colleague)->create();
        ConversationOffer::factory()->create(['conversation_id' => $offeredButClaimedByOther->id, 'user_id' => $agent->id]);
        $ticketInMyCategory = Conversation::factory()->offline()->forCategory($category)->create();
        $ticketElsewhere = Conversation::factory()->offline()->forCategory(Category::factory()->create())->create();
        $ticketWithoutCategory = Conversation::factory()->offline()->create();
        $liveInMyCategory = Conversation::factory()->forCategory($category)->create();
        $missed = Conversation::factory()->missed()->create();

        $all = Conversation::query()->count();
        $this->assertSame(13, $all);

        $this->assertSame($all, Conversation::query()->visibleTo($admin)->count());
        $this->assertEqualsCanonicalizing(
            [$mine->id, $mineEnded->id, $offered->id, $ticketInMyCategory->id],
            Conversation::query()->visibleTo($agent)->pluck('id')->all(),
        );
        $this->assertEqualsCanonicalizing(
            [$theirs->id, $offeredToColleague->id, $offeredButClaimedByOther->id],
            Conversation::query()->visibleTo($colleague)->pluck('id')->all(),
        );
        $this->assertSame([], Conversation::query()->visibleTo($stranger)->pluck('id')->all());
        $this->assertNotContains($missed->id, Conversation::query()->visibleTo($agent)->pluck('id')->all());
        $this->assertNotContains($ticketElsewhere->id, Conversation::query()->visibleTo($agent)->pluck('id')->all());
        $this->assertNotContains($ticketWithoutCategory->id, Conversation::query()->visibleTo($agent)->pluck('id')->all());
        $this->assertNotContains($liveInMyCategory->id, Conversation::query()->visibleTo($agent)->pluck('id')->all());
    }

    public function test_visible_to_shows_nothing_to_inactive_users_and_users_without_chat_roles(): void
    {
        Conversation::factory()->active()->create();
        $inactiveAdmin = User::factory()->admin()->inactive()->create();
        $inactiveAgent = User::factory()->inactive()->create();
        $noRole = User::factory()->withoutChatAccess()->create();
        $mine = Conversation::factory()->active($inactiveAgent)->create();

        $this->assertSame(0, Conversation::query()->visibleTo($inactiveAdmin)->count());
        $this->assertSame(0, Conversation::query()->visibleTo($inactiveAgent)->count());
        $this->assertSame(0, Conversation::query()->visibleTo($noRole)->count());
        $this->assertSame(2, Conversation::query()->count());
        $this->assertNotNull($mine->id);
    }

    public function test_visible_to_composes_with_other_constraints_and_joins(): void
    {
        $agent = User::factory()->create();
        $mine = Conversation::factory()->active($agent)->create();
        Conversation::factory()->closed($agent)->create();
        ConversationOffer::factory()->create(['conversation_id' => Conversation::factory()->create()->id, 'user_id' => $agent->id]);

        $ids = Conversation::query()
            ->join('visitors', 'visitors.id', '=', 'conversations.visitor_id')
            ->visibleTo($agent)
            ->open()
            ->orderBy('conversations.id')
            ->pluck('conversations.id')
            ->all();

        $this->assertCount(2, $ids);
        $this->assertContains($mine->id, $ids);
    }
}
