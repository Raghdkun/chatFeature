<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Realtime\Support\ConversationAudience;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Who a conversation's change is sent to is who may see it: the audience is pinned to `ConversationPolicy::viewAsStaff()`.
 */
class ConversationAudienceTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return list<User>
     */
    private function staff(Category $category): array
    {
        $servesCategory = User::factory()->agent()->create();
        $servesCategory->categories()->attach($category->id);

        return [
            'servesCategory' => $servesCategory,
            'plain' => User::factory()->agent()->create(),
            'offered' => User::factory()->agent()->create(),
            'expired' => User::factory()->agent()->create(),
            'assigned' => User::factory()->agent()->create(),
            'inactiveAssigned' => User::factory()->agent()->inactive()->create(),
            'roleless' => User::factory()->withoutChatAccess()->create(),
        ];
    }

    public function test_the_audience_is_exactly_the_agents_the_policy_lets_see_the_conversation(): void
    {
        $category = Category::factory()->create();
        $staff = $this->staff($category);
        $policy = app(ConversationPolicy::class);
        $audience = app(ConversationAudience::class);

        $live = Conversation::factory()->forCategory($category)->create();
        ConversationOffer::factory()->create(['conversation_id' => $live->id, 'user_id' => $staff['offered']->id]);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $live->id, 'user_id' => $staff['expired']->id]);
        $conversations = [
            'queued live chat with offers' => $live,
            'queued offline ticket' => Conversation::factory()->offline()->forCategory($category)->create(),
            'queued offline ticket without a topic' => Conversation::factory()->offline()->create(),
            'active offline ticket without a topic' => Conversation::factory()->offline()->active($staff['assigned'])->create(),
            'active chat' => Conversation::factory()->active($staff['assigned'])->forCategory($category)->create(),
            'active chat of a deactivated agent' => Conversation::factory()->active($staff['inactiveAssigned'])->create(),
            'ended chat' => Conversation::factory()->ended($staff['assigned'])->create(),
            'closed chat' => Conversation::factory()->closed($staff['assigned'])->create(),
            'missed chat' => Conversation::factory()->missed()->create(),
        ];

        foreach ($conversations as $label => $conversation) {
            $recipients = $audience->staffIds($conversation);

            foreach ($staff as $name => $user) {
                $this->assertSame(
                    $policy->viewAsStaff($user, $conversation),
                    in_array($user->id, $recipients, true),
                    "{$name} / {$label}",
                );
            }
        }
    }

    public function test_extra_staff_are_added_when_they_are_active(): void
    {
        $conversation = Conversation::factory()->create();
        $left = User::factory()->agent()->create();
        $gone = User::factory()->agent()->inactive()->create();

        $this->assertSame([$left->id], app(ConversationAudience::class)->staffIds($conversation, [$left->id, $gone->id, $left->id]));
    }

    public function test_an_assigned_admin_is_addressed_on_their_own_channel_too(): void
    {
        $admin = User::factory()->admin()->create();
        $conversation = Conversation::factory()->active($admin)->create();

        $this->assertSame([$admin->id], app(ConversationAudience::class)->staffIds($conversation));
    }
}
