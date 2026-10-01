<?php

namespace Tests\Feature\Dashboard;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `GET /offline-tickets`: open offline tickets only, scoped by `visibleTo` (an agent sees the unclaimed tickets of the categories they
 * serve and the ones they claimed; an admin sees all of them).
 */
class ChatOfflineTicketsPageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_the_page_needs_staff(): void
    {
        $this->get('/offline-tickets')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->withoutChatAccess()->create())->get('/offline-tickets')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->agent()->create())->get('/offline-tickets')->assertOk();
        $this->actingAs(User::factory()->admin()->create())->get('/offline-tickets')->assertOk();
    }

    public function test_an_admin_sees_every_open_ticket_oldest_first_and_nothing_else(): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();
        $older = Conversation::factory()->offline()->create(['created_at' => now()->subHours(3)]);
        $newer = Conversation::factory()->offline()->create(['created_at' => now()->subHour()]);
        $claimed = Conversation::factory()->offline()->active($agent)->create(['created_at' => now()->subHours(2)]);
        Conversation::factory()->offline()->closed($agent)->create();
        Conversation::factory()->create();
        Conversation::factory()->active($agent)->create();

        $this->actingAs($admin)->get('/offline-tickets')->assertInertia(fn (Assert $page) => $page
            ->component('offline-tickets/index')
            ->has('tickets', 3)
            ->where('tickets.0.ulid', $older->ulid)
            ->where('tickets.1.ulid', $claimed->ulid)
            ->where('tickets.2.ulid', $newer->ulid)
            ->where('tickets.0.type', 'offline')
            ->where('tickets.0.status', 'queued')
            ->where('tickets.1.status', 'active')
            ->etc());
    }

    public function test_an_agent_sees_unclaimed_tickets_of_their_categories_and_their_own_claims(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->agent()->create();
        $served = Category::factory()->create();
        $other = Category::factory()->create();
        $agent->categories()->attach($served->id);

        $visible = Conversation::factory()->offline()->forCategory($served)->create(['created_at' => now()->subHour()]);
        Conversation::factory()->offline()->forCategory($other)->create();
        // A ticket without any topic (its widget had none) is everybody's.
        $withoutTopic = Conversation::factory()->offline()->create(['created_at' => now()->subMinutes(30)]);
        Conversation::factory()->offline()->forCategory($served)->active($colleague)->create();
        $claimedByMe = Conversation::factory()->offline()->forCategory($other)->active($agent)->create(['created_at' => now()]);

        $this->actingAs($agent)->get('/offline-tickets')->assertInertia(fn (Assert $page) => $page
            ->has('tickets', 3)
            ->where('tickets.0.ulid', $visible->ulid)
            ->where('tickets.1.ulid', $withoutTopic->ulid)
            ->where('tickets.2.ulid', $claimedByMe->ulid)
            ->etc());
    }

    public function test_a_ticket_carries_the_visitor_contact_for_the_reply(): void
    {
        $admin = User::factory()->admin()->create();
        $ticket = Conversation::factory()->offline()->create(['last_message_preview' => 'Is anyone there?']);
        $ticket->visitor->update(['name' => 'Vera', 'email' => 'vera@example.com']);

        $this->actingAs($admin)->get('/offline-tickets')->assertInertia(fn (Assert $page) => $page
            ->where('tickets.0.visitor.name', 'Vera')
            ->where('tickets.0.visitor.email', 'vera@example.com')
            ->where('tickets.0.lastMessagePreview', 'Is anyone there?')
            ->etc());
    }
}
