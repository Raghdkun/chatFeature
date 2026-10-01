<?php

namespace Tests\Feature\Realtime;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\AuthCapabilities;
use App\Auth\Support\SessionContext;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Realtime\Channels\AdminChannel;
use App\Domain\Chat\Realtime\Channels\ConversationChannel;
use App\Domain\Chat\Realtime\Channels\PresenceStaffChannel;
use App\Domain\Chat\Realtime\Channels\StaffChannel;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Visitor;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `POST /broadcasting/auth` (the staff channel authoriser): the matrix of who may join which channel, through a web session and
 * through a Sanctum bearer, with the real Pusher broadcaster signing the answers.
 */
class ChannelAuthorizationTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase, WidgetFixtures;

    private const SOCKET = '1234.5678';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useReverbBroadcaster();
    }

    private function join(?User $user, string $channel): TestResponse
    {
        $client = $user === null ? $this : $this->actingAs($user);

        return $client->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => $channel]);
    }

    private function bearerJoin(string $token, string $channel): TestResponse
    {
        // A guard keeps the user it resolved for the rest of the process; a real server handles one request per process.
        $this->app['auth']->forgetGuards();

        return $this->withToken($token)->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => $channel]);
    }

    private function assertJoined(TestResponse $response, string $channel): void
    {
        $response->assertOk();
        $this->assertSame($this->expectedChannelAuth(self::SOCKET, $channel), $response->json('auth'));
    }

    // ---- private-staff.{userId} --------------------------------------------------------------------------------------------

    public function test_staff_join_their_own_channel_and_nobody_elses(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->agent()->create();
        $admin = User::factory()->admin()->create();

        $this->assertJoined($this->join($agent, 'private-staff.'.$agent->id), 'private-staff.'.$agent->id);
        $this->assertJoined($this->join($admin, 'private-staff.'.$admin->id), 'private-staff.'.$admin->id);

        $this->join($agent, 'private-staff.'.$colleague->id)->assertForbidden();
        $this->join($admin, 'private-staff.'.$agent->id)->assertForbidden();
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function malformedStaffChannels(): iterable
    {
        yield 'prefix of the id' => ['private-staff.{id}x'];
        yield 'leading zero' => ['private-staff.0{id}'];
        yield 'signed' => ['private-staff.+{id}'];
        yield 'no id' => ['private-staff'];
        yield 'extra segment' => ['private-staff.{id}.extra'];
        yield 'public name' => ['staff.{id}'];
        yield 'presence kind' => ['presence-staff.{id}'];
    }

    #[DataProvider('malformedStaffChannels')]
    public function test_a_staff_channel_must_be_spelled_exactly(string $template): void
    {
        $agent = User::factory()->agent()->create();

        $this->join($agent, str_replace('{id}', (string) $agent->id, $template))->assertForbidden();
    }

    public function test_the_per_user_channel_of_the_starter_kit_is_kept_for_the_owner(): void
    {
        $agent = User::factory()->agent()->create();
        $other = User::factory()->agent()->create();

        $this->assertJoined($this->join($agent, 'private-App.Models.User.'.$agent->id), 'private-App.Models.User.'.$agent->id);
        $this->join($agent, 'private-App.Models.User.'.$other->id)->assertForbidden();
    }

    // ---- presence-staff ----------------------------------------------------------------------------------------------------

    public function test_active_staff_join_the_roster_with_name_avatar_and_status_but_no_email(): void
    {
        $agent = User::factory()->agent()->create(['name' => 'Sam Agent', 'display_name' => 'Sam']);
        AgentPresence::factory()->online()->create(['user_id' => $agent->id]);

        $response = $this->join($agent, 'presence-staff')->assertOk();
        $data = json_decode((string) $response->json('channel_data'), true, 512, JSON_THROW_ON_ERROR);

        $this->assertSame((string) $agent->id, (string) $data['user_id']);
        $this->assertSame(['id' => $agent->id, 'name' => 'Sam', 'avatarUrl' => null, 'status' => 'online'], $data['user_info']);
        $this->assertStringNotContainsString($agent->email, (string) $response->getContent());
        $this->assertSame(
            self::REVERB_KEY.':'.hash_hmac('sha256', self::SOCKET.':presence-staff:'.$response->json('channel_data'), self::REVERB_SECRET),
            $response->json('auth'),
        );
    }

    public function test_a_member_without_stored_presence_is_listed_as_offline(): void
    {
        $agent = User::factory()->agent()->create();

        $data = json_decode((string) $this->join($agent, 'presence-staff')->assertOk()->json('channel_data'), true, 512, JSON_THROW_ON_ERROR);

        $this->assertSame(PresenceStatus::Offline->value, $data['user_info']['status']);
    }

    public function test_the_roster_exists_only_as_a_presence_channel(): void
    {
        $agent = User::factory()->agent()->create();

        $this->join($agent, 'private-staff')->assertForbidden();
        $this->join($agent, 'staff')->assertForbidden();
    }

    // ---- private-admin and the reserved WhatsApp channel -------------------------------------------------------------------

    public function test_only_admins_join_the_admin_channel(): void
    {
        $this->assertJoined($this->join(User::factory()->admin()->create(), 'private-admin'), 'private-admin');
        $this->join(User::factory()->agent()->create(), 'private-admin')->assertForbidden();
        $this->join(User::factory()->agent()->create(), 'presence-admin')->assertForbidden();
        $this->join(User::factory()->admin()->create(), 'presence-admin')->assertForbidden();
    }

    public function test_the_whatsapp_admin_channel_stays_closed_until_p6_even_for_admins(): void
    {
        $this->join(User::factory()->admin()->create(), 'private-whatsapp-admin')->assertForbidden();
        $this->join(User::factory()->agent()->create(), 'private-whatsapp-admin')->assertForbidden();
    }

    // ---- private-conversation.{ulid} ---------------------------------------------------------------------------------------

    public function test_an_admin_may_monitor_any_conversation(): void
    {
        $admin = User::factory()->admin()->create();

        foreach ([Conversation::factory()->create(), Conversation::factory()->active()->create(), Conversation::factory()->closed()->create()] as $conversation) {
            $this->assertJoined($this->join($admin, 'private-conversation.'.$conversation->ulid), 'private-conversation.'.$conversation->ulid);
        }
    }

    public function test_the_assigned_agent_joins_and_other_agents_do_not(): void
    {
        $assigned = User::factory()->agent()->create();
        $other = User::factory()->agent()->create();
        $conversation = Conversation::factory()->active($assigned)->create();
        $channel = 'private-conversation.'.$conversation->ulid;

        $this->assertJoined($this->join($assigned, $channel), $channel);
        $this->join($other, $channel)->assertForbidden();
    }

    public function test_an_agent_offered_a_queued_chat_may_watch_it_until_it_is_taken_or_the_offer_lapses(): void
    {
        $offered = User::factory()->agent()->create();
        $stranger = User::factory()->agent()->create();
        $conversation = Conversation::factory()->create();
        $channel = 'private-conversation.'.$conversation->ulid;
        $offer = ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $offered->id]);

        $this->assertJoined($this->join($offered, $channel), $channel);
        $this->join($stranger, $channel)->assertForbidden();

        $offer->forceFill(['expires_at' => now()->subSecond()])->save();
        $this->join($offered, $channel)->assertForbidden();

        $offer->forceFill(['expires_at' => now()->addMinute()])->save();
        $conversation->forceFill(['status' => 'active', 'assigned_agent_id' => $stranger->id])->save();
        $this->join($offered, $channel)->assertForbidden();
        $this->assertJoined($this->join($stranger, $channel), $channel);
    }

    public function test_agents_who_serve_the_category_of_an_offline_ticket_may_watch_it(): void
    {
        $category = Category::factory()->create();
        $server = User::factory()->agent()->create();
        $other = User::factory()->agent()->create();
        $server->categories()->attach($category->id);
        $ticket = Conversation::factory()->offline()->forCategory($category)->create();
        $channel = 'private-conversation.'.$ticket->ulid;

        $this->assertJoined($this->join($server, $channel), $channel);
        $this->join($other, $channel)->assertForbidden();
    }

    public function test_an_agent_of_another_category_does_not_see_a_queued_chat_of_this_one(): void
    {
        $billing = Category::factory()->create();
        $agentOfOther = User::factory()->agent()->create();
        $agentOfOther->categories()->attach(Category::factory()->create()->id);
        $conversation = Conversation::factory()->forCategory($billing)->create();

        $this->join($agentOfOther, 'private-conversation.'.$conversation->ulid)->assertForbidden();
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function badConversationChannels(): iterable
    {
        yield 'unknown ulid' => ['private-conversation.01JZZZZZZZZZZZZZZZZZZZZZZZ'];
        yield 'not a ulid' => ['private-conversation.not-a-ulid'];
        yield 'numeric id' => ['private-conversation.1'];
        yield 'empty id' => ['private-conversation.'];
        yield 'no id' => ['private-conversation'];
        yield 'extra segment' => ['private-conversation.{ulid}.x'];
        yield 'presence kind' => ['presence-conversation.{ulid}'];
        yield 'public name' => ['conversation.{ulid}'];
        yield 'wildcard' => ['private-conversation.*'];
    }

    #[DataProvider('badConversationChannels')]
    public function test_malformed_unknown_and_wrongly_kinded_conversation_channels_are_refused_even_for_admins(string $template): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->active($agent)->create();
        $channel = str_replace('{ulid}', $conversation->ulid, $template);

        $this->join($admin, $channel)->assertForbidden();
        $this->join($agent, $channel)->assertForbidden();
    }

    public function test_an_uppercased_ulid_is_still_the_same_conversation(): void
    {
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->active($agent)->create();

        // The id is case-insensitive in the database lookup, but the channel that events go to is the lower-case one.
        $this->assertJoined($this->join($agent, 'private-conversation.'.strtoupper($conversation->ulid)), 'private-conversation.'.strtoupper($conversation->ulid));
    }

    public function test_unknown_channels_are_refused(): void
    {
        $admin = User::factory()->admin()->create();

        foreach (['private-foo', 'private-', 'presence-foo.1', 'foo', 'private-staff.1.2', 'private-admin.1'] as $channel) {
            $this->join($admin, $channel)->assertForbidden();
        }
    }

    // ---- who is staff ------------------------------------------------------------------------------------------------------

    public function test_a_guest_is_refused(): void
    {
        $this->join(null, 'private-admin')->assertForbidden();
        $this->join(null, 'presence-staff')->assertForbidden();
    }

    public function test_a_deactivated_account_is_turned_away_by_the_session_check(): void
    {
        $agent = User::factory()->agent()->inactive()->create();

        $this->join($agent, 'private-staff.'.$agent->id)->assertUnauthorized()->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_an_account_without_a_chat_role_is_turned_away_by_the_chat_access_check(): void
    {
        $user = User::factory()->withoutChatAccess()->create();

        $this->join($user, 'private-staff.'.$user->id)->assertForbidden()->assertJsonPath('error.code', 'no_chat_access');
    }

    public function test_the_install_gate_still_applies(): void
    {
        InstallStateFake::make(installed: false);

        $this->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => 'private-admin'])->assertStatus(503);
    }

    public function test_the_channel_classes_refuse_inactive_and_role_less_users_even_if_a_guard_resolved_them(): void
    {
        $admin = User::factory()->admin()->inactive()->create();
        $roleless = User::factory()->withoutChatAccess()->create();
        $conversation = Conversation::factory()->active()->create();

        foreach ([$admin, $roleless] as $user) {
            $this->assertFalse(app(StaffChannel::class)->join($user, (string) $user->id));
            $this->assertFalse(app(AdminChannel::class)->join($user));
            $this->assertFalse(app(PresenceStaffChannel::class)->join($user));
            $this->assertFalse(app(ConversationChannel::class)->join($user, $conversation->ulid));
        }
    }

    // ---- Sanctum bearer (mobile) -------------------------------------------------------------------------------------------

    public function test_a_sanctum_bearer_joins_through_the_same_endpoint(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->agent()->create();
        $admin = User::factory()->admin()->create();
        $conversation = Conversation::factory()->active($agent)->create();
        $token = $agent->createToken('phone', ['staff'])->plainTextToken;

        $this->assertJoined($this->bearerJoin($token, 'private-staff.'.$agent->id), 'private-staff.'.$agent->id);
        $this->assertJoined($this->bearerJoin($token, 'private-conversation.'.$conversation->ulid), 'private-conversation.'.$conversation->ulid);
        $this->bearerJoin($token, 'private-staff.'.$colleague->id)->assertForbidden();
        $this->bearerJoin($token, 'private-admin')->assertForbidden();
        $this->assertJoined($this->bearerJoin($admin->createToken('phone', ['staff'])->plainTextToken, 'private-admin'), 'private-admin');
    }

    public function test_a_bearer_token_that_is_not_ours_gets_nothing(): void
    {
        $this->bearerJoin('not-a-token', 'private-admin')->assertForbidden();
    }

    public function test_a_visitor_token_is_no_staff_credential(): void
    {
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        $conversation = Conversation::factory()->create(['visitor_id' => $issued->session->visitor_id, 'visitor_session_id' => $issued->session->id]);

        $this->bearerJoin($issued->plaintext, 'private-conversation.'.$conversation->ulid)->assertForbidden();
    }

    public function test_a_bearer_whose_account_was_deactivated_has_lost_its_token(): void
    {
        $agent = User::factory()->agent()->create();
        $token = $agent->createToken('phone', ['staff'])->plainTextToken;

        $agent->forceFill(['is_active' => false])->save();

        $this->bearerJoin($token, 'private-staff.'.$agent->id)->assertForbidden();
    }

    public function test_a_bearer_whose_session_the_driver_judges_revoked_is_refused(): void
    {
        $agent = User::factory()->agent()->create();
        $token = $agent->createToken('phone', ['staff']);
        $seen = [];

        $driver = Mockery::mock(AuthDriver::class);
        $driver->shouldReceive('key')->andReturn('pizzasys');
        $driver->shouldReceive('capabilities')->andReturn(new AuthCapabilities(false, false, false, false, 'https://portal.example'));
        $driver->shouldReceive('validateSession')->andReturnUsing(function (User $user, SessionContext $context) use (&$seen): SessionVerdict {
            $seen[] = $context->sanctumTokenId;

            return SessionVerdict::Revoked;
        });
        settings()->set('auth.mode', 'pizzasys');
        app(AuthModeManager::class)->extend('pizzasys', fn () => $driver);

        $this->bearerJoin($token->plainTextToken, 'private-staff.'.$agent->id)->assertForbidden();
        $this->assertSame([(int) $token->accessToken->getKey()], array_values(array_unique($seen)));
    }

    public function test_a_bearer_is_refused_while_the_portal_cannot_be_asked_but_kept_when_it_is_merely_degraded(): void
    {
        $agent = User::factory()->agent()->create();
        $token = $agent->createToken('phone', ['staff'])->plainTextToken;
        $verdict = SessionVerdict::Unavailable;

        $driver = Mockery::mock(AuthDriver::class);
        $driver->shouldReceive('key')->andReturn('pizzasys');
        $driver->shouldReceive('capabilities')->andReturn(new AuthCapabilities(false, false, false, false, 'https://portal.example'));
        $driver->shouldReceive('validateSession')->andReturnUsing(function () use (&$verdict): SessionVerdict {
            return $verdict;
        });
        settings()->set('auth.mode', 'pizzasys');
        app(AuthModeManager::class)->extend('pizzasys', fn () => $driver);

        $this->bearerJoin($token, 'private-staff.'.$agent->id)->assertForbidden();

        $verdict = SessionVerdict::Degraded;
        $this->assertJoined($this->bearerJoin($token, 'private-staff.'.$agent->id), 'private-staff.'.$agent->id);
    }
}
