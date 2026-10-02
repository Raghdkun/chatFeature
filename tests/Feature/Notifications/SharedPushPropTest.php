<?php

namespace Tests\Feature\Notifications;

use App\Http\Middleware\HandleInertiaRequests;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\InteractsWithWebPush;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** The `push` shared Inertia prop: the public VAPID key for signed-in staff, null whenever the feature is off. */
class SharedPushPropTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_active_staff_get_the_public_key_and_nothing_else(): void
    {
        $this->useVapid();

        $this->actingAs(User::factory()->agent()->create())
            ->get(route('dashboard'))
            ->assertInertia(fn (Assert $page) => $page->where('push', ['vapidPublicKey' => $this->vapidPublicKey]));
    }

    public function test_the_private_key_is_never_shared(): void
    {
        $this->useVapid();

        $html = (string) $this->actingAs(User::factory()->agent()->create())->get(route('dashboard'))->getContent();

        $this->assertStringNotContainsString((string) config('push.vapid.private_key'), $html);
    }

    public function test_it_is_null_when_the_keys_are_not_configured(): void
    {
        $this->withoutVapid();

        $this->actingAs(User::factory()->agent()->create())
            ->get(route('dashboard'))
            ->assertInertia(fn (Assert $page) => $page->where('push', null));

        config(['push.vapid.public_key' => 'only-a-public-key', 'push.vapid.private_key' => null]);
        $this->actingAs(User::factory()->agent()->create())
            ->get(route('dashboard'))
            ->assertInertia(fn (Assert $page) => $page->where('push', null));
    }

    public function test_guests_and_staff_who_cannot_chat_never_get_it(): void
    {
        $this->useVapid();

        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page->where('push', null));

        foreach ([['is_admin' => false, 'is_agent' => false, 'is_active' => true], ['is_admin' => false, 'is_agent' => true, 'is_active' => false]] as $flags) {
            $request = Request::create('/dashboard');
            $request->setUserResolver(fn (): User => User::factory()->create($flags));

            $this->assertNull(app(HandleInertiaRequests::class)->share($request)['push'], json_encode($flags));
        }
    }

    public function test_admins_get_it_too(): void
    {
        $this->useVapid();

        $this->actingAs(User::factory()->admin()->create())
            ->get(route('dashboard'))
            ->assertInertia(fn (Assert $page) => $page->where('push.vapidPublicKey', $this->vapidPublicKey));
    }
}
