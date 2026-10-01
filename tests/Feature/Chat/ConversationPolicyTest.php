<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use Tests\TestCase;

/**
 * Staff authorisation of conversations: admin, assigned agent, offered-while-queued, everybody else, inactive accounts.
 * The policy is called directly where `Gate::before` (admins may do everything) would hide a state check.
 */
class ConversationPolicyTest extends TestCase
{
    use RefreshDatabase;

    private ConversationPolicy $policy;

    private User $admin;

    private User $adminWithoutChats;

    private User $agent;

    private User $colleague;

    private User $noRole;

    private User $inactiveAgent;

    private User $inactiveAdmin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->policy = new ConversationPolicy;
        $this->admin = User::factory()->admin()->create();
        $this->adminWithoutChats = User::factory()->admin()->create(['is_agent' => false]);
        $this->agent = User::factory()->create();
        $this->colleague = User::factory()->create();
        $this->noRole = User::factory()->withoutChatAccess()->create();
        $this->inactiveAgent = User::factory()->inactive()->create();
        $this->inactiveAdmin = User::factory()->admin()->inactive()->create();
    }

    private function offeredTo(Conversation $conversation, User $user): void
    {
        ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $user->id]);
    }

    public function test_the_policy_is_registered_for_conversations(): void
    {
        $this->assertInstanceOf(ConversationPolicy::class, Gate::getPolicyFor(Conversation::class));
    }

    public function test_view_any_is_for_active_staff_with_chat_access(): void
    {
        $this->assertTrue($this->policy->viewAny($this->admin));
        $this->assertTrue($this->policy->viewAny($this->adminWithoutChats));
        $this->assertTrue($this->policy->viewAny($this->agent));
        $this->assertFalse($this->policy->viewAny($this->noRole));
        $this->assertFalse($this->policy->viewAny($this->inactiveAgent));
        $this->assertFalse($this->policy->viewAny($this->inactiveAdmin));
    }

    public function test_an_active_admin_sees_every_conversation(): void
    {
        foreach ([Conversation::factory()->create(), Conversation::factory()->active($this->agent)->create(), Conversation::factory()->closed()->create(), Conversation::factory()->missed()->create()] as $conversation) {
            $this->assertTrue($this->policy->viewAsStaff($this->admin, $conversation));
            $this->assertTrue($this->policy->view($this->adminWithoutChats, $conversation));
            $this->assertFalse($this->policy->viewAsStaff($this->inactiveAdmin, $conversation));
        }
    }

    public function test_the_assigned_agent_keeps_seeing_the_conversation_after_it_ended_or_closed(): void
    {
        foreach ([Conversation::factory()->active($this->agent)->create(), Conversation::factory()->ended($this->agent)->create(), Conversation::factory()->closed($this->agent)->create()] as $conversation) {
            $this->assertTrue($this->policy->viewAsStaff($this->agent, $conversation));
            $this->assertFalse($this->policy->viewAsStaff($this->colleague, $conversation));
            $this->assertFalse($this->policy->viewAsStaff($this->noRole, $conversation));
        }
    }

    public function test_an_offered_agent_sees_a_queued_conversation_only_while_the_offer_is_open(): void
    {
        $conversation = Conversation::factory()->create();
        $this->offeredTo($conversation, $this->agent);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $conversation->id, 'user_id' => $this->colleague->id]);

        $this->assertTrue($this->policy->viewAsStaff($this->agent, $conversation));
        $this->assertFalse($this->policy->viewAsStaff($this->colleague, $conversation), 'expired offer');
        $this->assertFalse($this->policy->viewAsStaff($this->noRole, $conversation));
    }

    public function test_an_offer_does_not_open_a_conversation_that_is_no_longer_queued(): void
    {
        $conversation = Conversation::factory()->active($this->colleague)->create();
        $this->offeredTo($conversation, $this->agent);

        $this->assertFalse($this->policy->viewAsStaff($this->agent, $conversation));
        $this->assertTrue($this->policy->viewAsStaff($this->colleague, $conversation));
    }

    public function test_queued_offline_tickets_are_visible_to_agents_serving_the_category(): void
    {
        $category = Category::factory()->create();
        $category->users()->attach($this->agent->id);
        $ticket = Conversation::factory()->offline()->forCategory($category)->create();
        $uncategorised = Conversation::factory()->offline()->create();

        $this->assertTrue($this->policy->viewAsStaff($this->agent, $ticket));
        $this->assertFalse($this->policy->viewAsStaff($this->colleague, $ticket));
        $this->assertFalse($this->policy->viewAsStaff($this->agent, $uncategorised));
        $this->assertFalse($this->policy->viewAsStaff($this->agent, Conversation::factory()->forCategory($category)->create()), 'a live chat is not an offline ticket');
    }

    public function test_inactive_accounts_see_nothing_even_their_own_conversations(): void
    {
        $conversation = Conversation::factory()->active($this->inactiveAgent)->create();

        $this->assertFalse($this->policy->viewAsStaff($this->inactiveAgent, $conversation));
        $this->assertFalse($this->policy->view($this->inactiveAgent, $conversation));
    }

    public function test_view_as_staff_and_the_visible_to_scope_always_agree(): void
    {
        $category = Category::factory()->create();
        $category->users()->attach($this->agent->id);

        $conversations = [
            Conversation::factory()->create(),
            Conversation::factory()->active($this->agent)->create(),
            Conversation::factory()->active($this->colleague)->create(),
            Conversation::factory()->ended($this->agent)->create(),
            Conversation::factory()->closed($this->colleague)->create(),
            Conversation::factory()->missed()->create(),
            Conversation::factory()->offline()->forCategory($category)->create(),
            Conversation::factory()->offline()->create(),
            Conversation::factory()->active($this->inactiveAgent)->create(),
        ];
        $this->offeredTo($conversations[0], $this->agent);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $conversations[0]->id, 'user_id' => $this->colleague->id]);
        $this->offeredTo($conversations[2], $this->agent);

        $users = [$this->admin, $this->adminWithoutChats, $this->agent, $this->colleague, $this->noRole, $this->inactiveAgent, $this->inactiveAdmin];

        foreach ($users as $user) {
            $visible = Conversation::query()->visibleTo($user)->pluck('id')->all();

            foreach ($conversations as $conversation) {
                $this->assertSame(
                    in_array($conversation->id, $visible, true),
                    $this->policy->viewAsStaff($user, $conversation),
                    "user #{$user->id} / conversation #{$conversation->id} ({$conversation->type->value} {$conversation->status->value})",
                );
            }
        }
    }

    public function test_claim_needs_an_agent_who_can_see_the_queued_unassigned_chat(): void
    {
        $conversation = Conversation::factory()->create();
        $this->offeredTo($conversation, $this->agent);

        $this->assertTrue($this->policy->claim($this->agent, $conversation));
        $this->assertTrue($this->policy->claim($this->admin, $conversation), 'an admin who takes chats');
        $this->assertFalse($this->policy->claim($this->adminWithoutChats, $conversation), 'an admin who does not take chats');
        $this->assertFalse($this->policy->claim($this->colleague, $conversation), 'not offered');
        $this->assertFalse($this->policy->claim($this->noRole, $conversation));
        $this->assertFalse($this->policy->claim($this->inactiveAgent, $conversation));
    }

    public function test_claim_is_refused_once_the_conversation_is_not_queued_or_has_an_agent(): void
    {
        $taken = Conversation::factory()->active($this->colleague)->create();
        $this->offeredTo($taken, $this->agent);
        $assignedQueued = Conversation::factory()->create(['assigned_agent_id' => $this->colleague->id]);
        $this->offeredTo($assignedQueued, $this->agent);

        $this->assertFalse($this->policy->claim($this->agent, $taken));
        $this->assertFalse($this->policy->claim($this->agent, $assignedQueued));
        $this->assertFalse($this->policy->claim($this->agent, Conversation::factory()->closed()->create()));
        $this->assertFalse($this->policy->claim($this->admin, Conversation::factory()->active($this->colleague)->create()));
    }

    public function test_an_offline_ticket_can_be_claimed_by_an_agent_of_its_category(): void
    {
        $category = Category::factory()->create();
        $category->users()->attach($this->agent->id);
        $ticket = Conversation::factory()->offline()->forCategory($category)->create();

        $this->assertTrue($this->policy->claim($this->agent, $ticket));
        $this->assertFalse($this->policy->claim($this->colleague, $ticket));
    }

    public function test_send_is_for_the_assigned_agent_or_an_admin_while_the_chat_is_active(): void
    {
        $active = Conversation::factory()->active($this->agent)->create();

        $this->assertTrue($this->policy->send($this->agent, $active));
        $this->assertTrue($this->policy->send($this->admin, $active));
        $this->assertFalse($this->policy->send($this->colleague, $active));
        $this->assertFalse($this->policy->send($this->noRole, $active));
        $this->assertFalse($this->policy->send($this->inactiveAdmin, $active));

        foreach ([Conversation::factory()->create(), Conversation::factory()->ended($this->agent)->create(), Conversation::factory()->closed($this->agent)->create(), Conversation::factory()->missed()->create()] as $conversation) {
            $this->assertFalse($this->policy->send($this->agent, $conversation), $conversation->status->value);
            $this->assertFalse($this->policy->send($this->admin, $conversation), $conversation->status->value);
        }
    }

    public function test_end_applies_to_active_live_chats_only(): void
    {
        $active = Conversation::factory()->active($this->agent)->create();

        $this->assertTrue($this->policy->end($this->agent, $active));
        $this->assertTrue($this->policy->end($this->admin, $active));
        $this->assertFalse($this->policy->end($this->colleague, $active));
        $this->assertFalse($this->policy->end($this->agent, Conversation::factory()->offline()->active($this->agent)->create()), 'offline tickets are closed, not ended');
        $this->assertFalse($this->policy->end($this->agent, Conversation::factory()->ended($this->agent)->create()));
        $this->assertFalse($this->policy->end($this->agent, Conversation::factory()->create()));
    }

    public function test_transfer_is_for_the_assigned_agent_or_an_admin_of_an_active_chat(): void
    {
        $active = Conversation::factory()->active($this->agent)->create();

        $this->assertTrue($this->policy->transfer($this->agent, $active));
        $this->assertTrue($this->policy->transfer($this->admin, $active));
        $this->assertFalse($this->policy->transfer($this->colleague, $active));
        $this->assertFalse($this->policy->transfer($this->agent, Conversation::factory()->ended($this->agent)->create()));
        $this->assertFalse($this->policy->transfer($this->agent, Conversation::factory()->create()));
    }

    public function test_assign_is_admin_only_for_queued_and_active_conversations(): void
    {
        $queued = Conversation::factory()->create();
        $active = Conversation::factory()->active($this->agent)->create();

        $this->assertTrue($this->policy->assign($this->admin, $queued));
        $this->assertTrue($this->policy->assign($this->admin, $active));
        $this->assertFalse($this->policy->assign($this->agent, $active));
        $this->assertFalse($this->policy->assign($this->inactiveAdmin, $queued));
        $this->assertFalse($this->policy->assign($this->admin, Conversation::factory()->closed()->create()));
        $this->assertFalse($this->policy->assign($this->admin, Conversation::factory()->ended()->create()));
    }

    public function test_close_is_for_the_assigned_agent_or_admin_and_never_for_terminal_conversations(): void
    {
        $active = Conversation::factory()->active($this->agent)->create();
        $ended = Conversation::factory()->ended($this->agent)->create();
        $queued = Conversation::factory()->create();

        $this->assertTrue($this->policy->close($this->agent, $active));
        $this->assertTrue($this->policy->close($this->agent, $ended));
        $this->assertTrue($this->policy->close($this->admin, $active));
        $this->assertFalse($this->policy->close($this->colleague, $active));
        $this->assertTrue($this->policy->close($this->admin, $queued));
        $this->assertFalse($this->policy->close($this->agent, $queued), 'only an admin can dismiss a queued conversation');
        $this->assertFalse($this->policy->close($this->admin, Conversation::factory()->closed()->create()));
        $this->assertFalse($this->policy->close($this->admin, Conversation::factory()->missed()->create()));
    }

    public function test_ratings_are_for_administrators(): void
    {
        $conversation = Conversation::factory()->closed($this->agent)->create();

        $this->assertTrue($this->policy->viewRating($this->admin, $conversation));
        $this->assertFalse($this->policy->viewRating($this->agent, $conversation), 'not even the assigned agent');
        $this->assertFalse($this->policy->viewRating($this->inactiveAdmin, $conversation));
    }

    public function test_the_gate_applies_the_policy_to_agents(): void
    {
        $mine = Conversation::factory()->active($this->agent)->create();
        $theirs = Conversation::factory()->active($this->colleague)->create();

        $this->assertTrue($this->agent->can('view', $mine));
        $this->assertFalse($this->agent->can('view', $theirs));
        $this->assertTrue($this->agent->can('send', $mine));
        $this->assertFalse($this->agent->can('send', $theirs));
        $this->assertFalse($this->noRole->can('view', $mine));
        $this->assertFalse($this->inactiveAgent->can('viewAny', Conversation::class));
        $this->assertTrue($this->agent->can('viewAny', Conversation::class));
    }

    public function test_gate_before_lets_active_admins_through_every_ability_so_state_checks_belong_to_the_actions(): void
    {
        $closed = Conversation::factory()->closed()->create();

        $this->assertTrue($this->admin->can('send', $closed), 'Gate::before grants admins everything');
        $this->assertFalse($this->policy->send($this->admin, $closed), 'the policy itself checks the state');
        $this->assertFalse($this->inactiveAdmin->can('send', $closed));
    }
}
