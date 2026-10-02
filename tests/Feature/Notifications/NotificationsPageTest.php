<?php

namespace Tests\Feature\Notifications;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `GET /settings/notifications`: the Inertia page behind Settings > Notifications. */
class NotificationsPageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_staff_get_the_page(): void
    {
        foreach ([User::factory()->agent()->create(), User::factory()->admin()->create()] as $user) {
            $this->actingAs($user)
                ->get('/settings/notifications')
                ->assertOk()
                ->assertInertia(fn (Assert $page) => $page->component('settings/notifications'));
        }
    }

    public function test_the_route_is_named_and_lives_next_to_the_other_settings(): void
    {
        $this->assertSame('/settings/notifications', route('notifications.edit', absolute: false));
    }

    public function test_guests_are_sent_to_sign_in(): void
    {
        $this->get('/settings/notifications')->assertRedirect(route('login'));
    }

    public function test_an_account_without_a_chat_role_is_turned_away(): void
    {
        $nobody = User::factory()->create(['is_admin' => false, 'is_agent' => false]);

        $this->actingAs($nobody)->get('/settings/notifications')->assertRedirect();
        $this->assertGuest();
    }
}
