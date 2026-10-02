<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Visitors\VisitorTokenService;
use App\Domain\WhatsApp\Enums\WaRealtimeEvent;
use App\Domain\WhatsApp\Support\WhatsAppAdminChannel;
use App\Domain\WhatsApp\Support\WhatsAppRealtime;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `private-whatsapp-admin` (decision P6-D1): active administrators only, through a web session and through a Sanctum bearer; agents,
 * accounts without a role, deactivated administrators, guests and visitors are refused, and so is every other spelling of the name.
 */
class WhatsAppChannelAuthorizationTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private const SOCKET = '1234.5678';

    private const CHANNEL = 'private-whatsapp-admin';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useReverbBroadcaster();
    }

    private function join(?User $user, string $channel = self::CHANNEL): TestResponse
    {
        $client = $user === null ? $this : $this->actingAs($user);

        return $client->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => $channel]);
    }

    private function bearerJoin(string $token, string $channel = self::CHANNEL): TestResponse
    {
        // A guard keeps the user it resolved for the rest of the process; a real server handles one request per process.
        $this->app['auth']->forgetGuards();

        return $this->withToken($token)->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => $channel]);
    }

    private function assertJoined(TestResponse $response): void
    {
        $response->assertOk();
        $this->assertSame($this->expectedChannelAuth(self::SOCKET, self::CHANNEL), $response->json('auth'));
    }

    public function test_the_channel_and_event_names_are_spelled_in_one_place(): void
    {
        $this->assertSame('private-whatsapp-admin', WhatsAppRealtime::adminChannel()->name);
        $this->assertSame('whatsapp-admin', WhatsAppRealtime::ADMIN_CHANNEL);
        $this->assertSame(['wa.message.created', 'wa.message.updated', 'wa.chat.updated', 'wa.session.status'], array_column(WaRealtimeEvent::cases(), 'value'));
    }

    public function test_active_administrators_join_and_get_a_signed_answer(): void
    {
        $people = $this->whatsAppPeople();

        $this->assertJoined($this->join($people['admin']));
        $this->assertJoined($this->join($people['adminAndAgent']));
    }

    /**
     * @return iterable<string, array{string, int}>
     */
    public static function peopleWhoAreRefused(): iterable
    {
        yield 'agent' => ['agent', 403];
        yield 'user without a chat role' => ['noRole', 403];
        // The session check ends the session of a deactivated account before the channel is asked.
        yield 'deactivated administrator' => ['inactiveAdmin', 401];
        yield 'deactivated agent' => ['inactiveAgent', 401];
    }

    #[DataProvider('peopleWhoAreRefused')]
    public function test_everybody_else_is_refused(string $person, int $status): void
    {
        $this->join($this->whatsAppPeople()[$person])->assertStatus($status)->assertJsonMissingPath('auth');
    }

    public function test_a_guest_is_refused(): void
    {
        $this->join(null)->assertForbidden();
    }

    public function test_a_visitor_is_refused_on_both_authorisation_endpoints(): void
    {
        $visitor = Visitor::factory()->create(['widget_id' => Widget::factory()->create()->id]);
        $conversation = Conversation::factory()->create(['visitor_id' => $visitor->id, 'widget_id' => $visitor->widget_id]);
        $issued = app(VisitorTokenService::class)->issue($visitor);

        $this->bearerJoin($issued->plaintext)->assertForbidden();

        $this->app['auth']->forgetGuards();
        $this->withToken($issued->plaintext)
            ->postJson('/api/v1/public/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => self::CHANNEL])
            ->assertForbidden();

        $this->assertNotNull($conversation->ulid);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function otherSpellings(): iterable
    {
        yield 'presence kind' => ['presence-whatsapp-admin'];
        yield 'public name' => ['whatsapp-admin'];
        yield 'extra segment' => ['private-whatsapp-admin.1'];
        yield 'longer name' => ['private-whatsapp-admins'];
        yield 'prefix of the name' => ['private-whatsapp'];
        yield 'reversed' => ['private-admin-whatsapp'];
        yield 'upper case' => ['private-WhatsApp-Admin'];
        yield 'prefixed' => ['x-private-whatsapp-admin'];
        yield 'wildcard' => ['private-whatsapp-*'];
        yield 'empty' => [''];
    }

    #[DataProvider('otherSpellings')]
    public function test_the_channel_exists_in_exactly_one_spelling_even_for_administrators(string $channel): void
    {
        $this->join($this->whatsAppPeople()['admin'], $channel)->assertForbidden();
    }

    public function test_the_admin_channel_does_not_open_the_whatsapp_one_and_the_other_way_round(): void
    {
        $agent = User::factory()->agent()->create();
        $admin = User::factory()->admin()->create();

        $this->join($agent, 'private-admin')->assertForbidden();
        $this->join($agent, self::CHANNEL)->assertForbidden();
        $this->assertJoined($this->join($admin));
        $this->join($admin, 'private-admin')->assertOk();
    }

    public function test_a_sanctum_bearer_joins_through_the_same_endpoint(): void
    {
        $people = $this->whatsAppPeople();

        $this->assertJoined($this->bearerJoin($people['admin']->createToken('phone', ['staff'])->plainTextToken));
        $this->bearerJoin($people['agent']->createToken('phone', ['staff'])->plainTextToken)->assertForbidden();
        $this->bearerJoin('not-a-token')->assertForbidden();
    }

    public function test_a_bearer_whose_account_was_deactivated_has_lost_its_token(): void
    {
        $admin = User::factory()->admin()->create();
        $token = $admin->createToken('phone', ['staff'])->plainTextToken;
        $this->assertJoined($this->bearerJoin($token));

        $admin->forceFill(['is_active' => false])->save();

        $this->bearerJoin($token)->assertForbidden();
    }

    public function test_the_channel_class_refuses_inactive_and_role_less_users_even_if_a_guard_resolved_them(): void
    {
        $people = $this->whatsAppPeople();

        foreach (['agent', 'noRole', 'inactiveAdmin', 'inactiveAgent'] as $person) {
            $this->assertFalse(app(WhatsAppAdminChannel::class)->join($people[$person]), $person);
        }

        $this->assertFalse(app(WhatsAppAdminChannel::class)->join(null));
    }
}
