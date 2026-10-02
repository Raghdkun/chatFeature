<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Realtime\Sockets\SocketCutOff;
use App\Domain\Chat\Realtime\Sockets\SocketTags;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\PendingSocketCut;
use App\Models\RealtimeGrant;
use App\Models\User;
use App\Models\VisitorSession;
use Illuminate\Auth\Events\Logout;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Schema;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\RecordingBroadcaster;
use Tests\TestCase;

/**
 * The stale-socket cut-off (P7, docs/realtime.md "Cutting a socket off"): authorisation happens when a client subscribes, so a staff
 * member who was deactivated or demoted, an agent a chat was taken from and a visitor whose token ended must have their open sockets
 * CLOSED. The signature of every private subscription carries the principal's tag; Reverb closes the sockets that carry it; the client
 * reconnects and is authorised (or refused) against the current state.
 *
 * Nothing here opens a socket: what the application asks Reverb to close is recorded (`RecordingSocketTerminator`), the signed
 * answers come from the real Pusher broadcaster. The real-socket proof is `e2e/support/realtime-cutoff-smoke.mjs`.
 */
class SocketCutOffTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, RefreshDatabase;

    private const SOCKET = '4711.815';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useReverbBroadcaster();
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------

    private function join(User $user, string $channel): TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->actingAs($user)->postJson('/broadcasting/auth', ['socket_id' => self::SOCKET, 'channel_name' => $channel]);
    }

    private function joinConversation(User $user, Conversation $conversation): TestResponse
    {
        return $this->join($user, 'private-conversation.'.$conversation->ulid);
    }

    private function visitorJoin(IssuedVisitorToken $token, Conversation $conversation): TestResponse
    {
        return $this->withToken($token->plaintext)->postJson('/api/v1/public/broadcasting/auth', [
            'socket_id' => self::SOCKET,
            'channel_name' => 'private-conversation.'.$conversation->ulid,
        ]);
    }

    /** @return list<string> */
    private function staffTags(User $user): array
    {
        return SocketTags::allForStaff($user->id);
    }

    private function assertCut(User $user): void
    {
        foreach ($this->staffTags($user) as $tag) {
            $this->assertTrue($this->sockets->was($tag), 'Expected the sockets tagged '.$tag.' of user '.$user->id.' to be closed.');
        }
    }

    private function assertNotCut(User $user): void
    {
        foreach ($this->staffTags($user) as $tag) {
            $this->assertFalse($this->sockets->was($tag), 'Did not expect the sockets of user '.$user->id.' to be closed.');
        }
    }

    // ---- what the signature carries ----------------------------------------------------------------------------------------

    public function test_every_private_staff_subscription_is_signed_with_an_opaque_tag_and_the_roster_with_the_user_id(): void
    {
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->active($agent)->create();

        foreach (['private-staff.'.$agent->id, 'private-conversation.'.$conversation->ulid, 'private-App.Models.User.'.$agent->id] as $channel) {
            $response = $this->join($agent, $channel)->assertOk();
            $data = (string) $response->json('channel_data');

            $this->assertSame($this->channelDataFor(SocketTags::staff($agent->id)), $data);
            $this->assertSame($this->expectedChannelAuth(self::SOCKET, $channel, $data), $response->json('auth'));
        }

        // `client-typing` whispers are re-broadcast with the sender's user id: the tag must not be (or contain) the integer id.
        $this->assertNotSame((string) $agent->id, SocketTags::staff($agent->id));
        $this->assertStringNotContainsString('"user_id":"'.$agent->id.'"', $this->join($agent, 'private-staff.'.$agent->id)->json('channel_data'));

        $presence = json_decode((string) $this->join($agent, 'presence-staff')->json('channel_data'), true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame((string) $agent->id, (string) $presence['user_id']);
        $this->assertContains((string) $agent->id, SocketTags::allForStaff($agent->id));
    }

    public function test_a_visitor_subscription_is_signed_with_the_tag_of_that_session_alone(): void
    {
        [$widget, $category] = $this->chatWidget();
        $first = $this->visitorSession($widget);
        $conversation = $this->queuedChat($first, $category);

        $data = (string) $this->visitorJoin($first, $conversation)->assertOk()->json('channel_data');

        $this->assertSame($this->channelDataFor(SocketTags::visitorSession($first->session->id)), $data);
        $this->assertNotSame(SocketTags::visitorSession($first->session->id), SocketTags::visitorSession($first->session->id + 1));
        $this->assertStringNotContainsString($first->session->ulid, $data);
    }

    public function test_the_same_principal_always_gets_the_same_tag_and_different_ones_differ(): void
    {
        $this->assertSame(SocketTags::staff(5), SocketTags::staff(5));
        $this->assertNotSame(SocketTags::staff(5), SocketTags::staff(6));
        $this->assertNotSame(SocketTags::staff(5), SocketTags::visitorSession(5));
        $this->assertMatchesRegularExpression('/^s_[0-9a-f]{24}$/D', SocketTags::staff(5));
        $this->assertMatchesRegularExpression('/^v_[0-9a-f]{24}$/D', SocketTags::visitorSession(5));

        config(['app.key' => 'base64:'.base64_encode(random_bytes(32))]);
        $this->assertNotSame(SocketTags::staff(5), 's_'.substr(hash_hmac('sha256', 'staff:5', 'x'), 0, 24));
    }

    // ---- staff: an account that loses its right ----------------------------------------------------------------------------

    public function test_an_account_that_is_deactivated_loses_its_sockets(): void
    {
        $agent = User::factory()->agent()->create();

        $agent->forceFill(['is_active' => false])->save();

        $this->assertCut($agent);
    }

    public function test_an_administrator_demoted_to_agent_loses_its_sockets(): void
    {
        $adminAgent = User::factory()->admin()->create(['is_agent' => true]);

        $adminAgent->forceFill(['is_admin' => false])->save();

        $this->assertCut($adminAgent);
    }

    public function test_an_agent_who_loses_the_agent_role_loses_its_sockets(): void
    {
        $adminAgent = User::factory()->admin()->create(['is_agent' => true]);

        $adminAgent->forceFill(['is_agent' => false])->save();

        $this->assertCut($adminAgent);
    }

    public function test_a_deleted_account_loses_its_sockets(): void
    {
        $agent = User::factory()->agent()->create();

        $agent->delete();

        $this->assertCut($agent);
    }

    public function test_gaining_a_role_being_reactivated_or_an_unrelated_change_closes_nothing(): void
    {
        $agent = User::factory()->agent()->inactive()->create();

        $agent->forceFill(['is_active' => true])->save();
        $agent->forceFill(['is_admin' => true])->save();
        $agent->forceFill(['name' => 'Renamed'])->save();
        $agent->forceFill(['last_seen_at' => now()])->save();

        $this->assertSame([], $this->sockets->terminated);
    }

    public function test_the_agents_api_cuts_the_sockets_after_the_change_is_committed(): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();
        $moment = null;
        $this->sockets->onTerminate = function () use ($agent, &$moment): void {
            // At the moment Reverb is asked, the change is already visible to the authorisation that follows.
            $moment = User::query()->find($agent->id)->is_active;
        };

        $this->actingAs($admin, 'sanctum')->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => false])->assertOk();

        $this->assertCut($agent);
        $this->assertFalse($moment);
    }

    public function test_a_change_that_is_rolled_back_closes_nothing(): void
    {
        $agent = User::factory()->agent()->create();

        try {
            DB::transaction(function () use ($agent): void {
                $agent->forceFill(['is_active' => false])->save();

                throw new \RuntimeException('rolled back');
            });
        } catch (\RuntimeException) {
            // expected
        }

        $this->assertSame([], $this->sockets->terminated);
    }

    public function test_session_revoked_is_published_before_the_sockets_are_closed(): void
    {
        $wire = $this->recordBroadcasts();
        $this->sockets->onTerminate = fn () => $this->assertNotEmpty($wire->of('session.revoked'), 'session.revoked must reach the socket before it is closed');
        $agent = User::factory()->agent()->create();

        StaffSessionRevoked::dispatch($agent->id, SessionRevokeReason::AuthRevoked);

        $this->assertCut($agent);
        $this->assertCount(1, $wire->of('session.revoked'));
    }

    public function test_signing_out_closes_the_sockets_of_staff_only(): void
    {
        $agent = User::factory()->agent()->create();
        $roleless = User::factory()->withoutChatAccess()->create();

        event(new Logout('web', $roleless));
        $this->assertSame([], $this->sockets->terminated);

        event(new Logout('web', $agent));
        $this->assertCut($agent);
    }

    // ---- staff: a conversation that is taken away --------------------------------------------------------------------------

    /** @return array{0: User, 1: User, 2: Conversation} the agent, a colleague and the agent's active chat */
    private function agentsWithActiveChat(): array
    {
        [$widget, $category] = $this->chatWidget();
        $agent = $this->availableAgent($category);
        $colleague = $this->availableAgent($category);
        $chat = $this->activeChat($this->visitorSession($widget), $category, $agent);

        return [$agent, $colleague, $chat];
    }

    public function test_an_agent_a_chat_was_transferred_away_from_loses_the_sockets_that_may_hold_it(): void
    {
        [$agent, $colleague, $chat] = $this->agentsWithActiveChat();
        $this->joinConversation($agent, $chat)->assertOk();
        $this->assertSame(1, RealtimeGrant::query()->count());

        $this->actingAs($agent, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/transfer', ['agent_id' => $colleague->id])->assertOk();

        $this->assertCut($agent);
        $this->assertNotCut($colleague);
        $this->assertSame(0, RealtimeGrant::query()->count(), 'the grant is spent once the access is judged lost');
        $this->joinConversation($agent, $chat)->assertForbidden();
    }

    public function test_an_agent_who_still_may_see_the_chat_is_not_cut(): void
    {
        [$widget, $category] = $this->chatWidget();
        $offered = $this->availableAgent($category);
        $chat = $this->queuedChat($this->visitorSession($widget), $category, [$offered]);
        $this->joinConversation($offered, $chat)->assertOk();

        // The chat enters the queue again (another routing wave): the open offer still lets this agent see it.
        ConversationQueued::dispatch($chat);

        $this->assertNotCut($offered);
        $this->assertSame(1, RealtimeGrant::query()->where('user_id', $offered->id)->count());
    }

    public function test_only_agents_that_hold_a_grant_are_cut(): void
    {
        [$agent, $colleague, $chat] = $this->agentsWithActiveChat();

        // The agent never subscribed (no signed subscription exists), so a transfer costs them nothing.
        $this->actingAs($agent, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/transfer', ['agent_id' => $colleague->id])->assertOk();

        $this->assertSame([], $this->sockets->terminated);
    }

    public function test_a_refused_subscription_leaves_no_grant(): void
    {
        [$agent, $colleague, $chat] = $this->agentsWithActiveChat();

        $this->joinConversation($colleague, $chat)->assertForbidden();

        $this->assertSame(0, RealtimeGrant::query()->count());
    }

    public function test_administrators_are_not_recorded_because_their_access_follows_the_role(): void
    {
        [$agent, $colleague, $chat] = $this->agentsWithActiveChat();
        $admin = User::factory()->admin()->create();

        $this->joinConversation($admin, $chat)->assertOk();
        $this->actingAs($agent, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/transfer', ['agent_id' => $colleague->id])->assertOk();

        $this->assertSame(0, RealtimeGrant::query()->where('user_id', $admin->id)->count());
        $this->assertNotCut($admin);
    }

    public function test_an_agent_who_lost_the_race_for_an_offer_but_had_the_chat_open_is_cut_when_somebody_else_claims_it(): void
    {
        [$widget, $category] = $this->chatWidget();
        $winner = $this->availableAgent($category);
        $loser = $this->availableAgent($category);
        $bystander = $this->availableAgent($category);
        $chat = $this->queuedChat($this->visitorSession($widget), $category, [$winner, $loser, $bystander]);

        $this->joinConversation($loser, $chat)->assertOk();
        $this->joinConversation($winner, $chat)->assertOk();

        $this->actingAs($winner, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/claim')->assertOk();

        $this->assertCut($loser);
        $this->assertNotCut($winner);
        $this->assertNotCut($bystander);
    }

    public function test_the_sweep_judges_the_grants_of_recently_changed_conversations_again(): void
    {
        [$agent, $colleague, $chat] = $this->agentsWithActiveChat();
        $this->joinConversation($agent, $chat)->assertOk();

        // A change no event announced (a console command, a crashed listener).
        Conversation::query()->whereKey($chat->id)->update(['assigned_agent_id' => $colleague->id]);
        $this->assertNotCut($agent);

        Artisan::call('chat:realtime-sweep');

        $this->assertCut($agent);
        $this->assertNotCut($colleague);
    }

    public function test_old_grants_are_pruned_and_fresh_ones_kept(): void
    {
        [$agent, , $chat] = $this->agentsWithActiveChat();
        $other = Conversation::factory()->active($agent)->create();
        $this->joinConversation($agent, $chat)->assertOk();
        $this->joinConversation($agent, $other)->assertOk();
        RealtimeGrant::query()->where('conversation_id', $other->id)->update(['granted_at' => now()->subDays(15)]);

        Artisan::call('chat:realtime-sweep');

        $this->assertSame([$chat->id], RealtimeGrant::query()->pluck('conversation_id')->all());
    }

    public function test_granting_again_refreshes_one_row(): void
    {
        [$agent, , $chat] = $this->agentsWithActiveChat();

        $this->joinConversation($agent, $chat)->assertOk();
        RealtimeGrant::query()->update(['granted_at' => now()->subDays(3)]);
        $this->joinConversation($agent, $chat)->assertOk();

        $this->assertSame(1, RealtimeGrant::query()->count());
        $this->assertTrue(RealtimeGrant::query()->sole()->granted_at->isAfter(now()->subMinute()));
    }

    // ---- visitors ----------------------------------------------------------------------------------------------------------

    public function test_the_first_signed_subscription_of_a_visitor_session_is_noted_once(): void
    {
        [$widget, $category] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $conversation = $this->queuedChat($token, $category);

        $this->visitorJoin($token, $conversation)->assertOk();
        $first = VisitorSession::query()->findOrFail($token->session->id)->socket_authorized_at;
        $this->assertNotNull($first);

        $this->travel(5)->minutes();
        $this->visitorJoin($token, $conversation)->assertOk();

        $this->assertEquals($first, VisitorSession::query()->findOrFail($token->session->id)->socket_authorized_at);
    }

    public function test_signing_the_visitor_out_closes_the_sockets_of_every_session_of_theirs(): void
    {
        [$widget] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $second = app(VisitorTokenService::class)->issue($token->session->visitor);

        $this->withToken($token->plaintext)->deleteJson('/api/v1/public/sessions')->assertNoContent();

        $this->assertTrue($this->sockets->was(SocketTags::visitorSession($token->session->id)));
        $this->assertTrue($this->sockets->was(SocketTags::visitorSession($second->session->id)));
    }

    public function test_a_rotated_token_loses_its_sockets_at_once_and_the_new_one_keeps_its_own(): void
    {
        [$widget, $category] = $this->chatWidget();
        $old = $this->visitorSession($widget);
        $this->activeChat($old, $category, $this->availableAgent($category));

        $response = $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$old->plaintext])
            ->postJson('/api/v1/public/widgets/'.$widget->public_key.'/sessions')->assertCreated();

        $new = VisitorSession::query()->where('visitor_id', $old->session->visitor_id)->where('id', '!=', $old->session->id)->sole();
        $this->assertSame($new->ulid === '' ? null : 'vt_', substr((string) $response->json('data.visitorToken'), 0, 3));
        $this->assertTrue($this->sockets->was(SocketTags::visitorSession($old->session->id)), 'the previous token has nothing to listen to any more');
        $this->assertFalse($this->sockets->was(SocketTags::visitorSession($new->id)));
    }

    public function test_the_sweep_closes_the_sockets_of_an_expired_token_once_and_ignores_sessions_that_never_subscribed(): void
    {
        [$widget, $category] = $this->chatWidget();
        $subscribed = $this->visitorSession($widget);
        $silent = $this->visitorSession($widget);
        $this->visitorJoin($subscribed, $this->queuedChat($subscribed, $category))->assertOk();
        $this->assertSame([], $this->sockets->terminated);

        $this->travel(31)->days();
        Artisan::call('chat:realtime-sweep');

        $this->assertSame(1, $this->sockets->count(SocketTags::visitorSession($subscribed->session->id)));
        $this->assertFalse($this->sockets->was(SocketTags::visitorSession($silent->session->id)));
        $this->assertNotNull(VisitorSession::query()->findOrFail($subscribed->session->id)->sockets_cut_at);

        // Nothing is cut again for the same expiry (only the parked follow-up, which is not due yet).
        Artisan::call('chat:realtime-sweep');
        $this->assertSame(1, $this->sockets->count(SocketTags::visitorSession($subscribed->session->id)));
    }

    public function test_a_token_that_is_valid_may_subscribe_again_after_a_cut_and_is_cut_again_when_it_ends(): void
    {
        [$widget, $category] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $conversation = $this->queuedChat($token, $category);
        $this->visitorJoin($token, $conversation)->assertOk();
        VisitorSession::query()->whereKey($token->session->id)->update(['sockets_cut_at' => now()]);

        $this->visitorJoin($token, $conversation)->assertOk();

        $this->assertNull(VisitorSession::query()->findOrFail($token->session->id)->sockets_cut_at);
    }

    public function test_a_revoked_token_cannot_subscribe_and_is_cut_by_the_sweep_when_no_event_announced_it(): void
    {
        [$widget, $category] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $conversation = $this->queuedChat($token, $category);
        $this->visitorJoin($token, $conversation)->assertOk();

        // Revoked behind the application's back (a console command, a manual UPDATE): no event.
        VisitorSession::query()->whereKey($token->session->id)->update(['revoked_at' => now()]);
        $this->visitorJoin($token, $conversation)->assertUnauthorized();

        Artisan::call('chat:realtime-sweep');

        $this->assertTrue($this->sockets->was(SocketTags::visitorSession($token->session->id)));
    }

    // ---- reliability -------------------------------------------------------------------------------------------------------

    public function test_a_cut_that_cannot_reach_reverb_never_throws_and_is_retried_by_the_sweep(): void
    {
        Exceptions::fake();
        $agent = User::factory()->agent()->create();
        $this->sockets->failWith();

        app(SocketCutOff::class)->cutStaff($agent->id, 'test');

        Exceptions::assertReported(fn (\RuntimeException $exception): bool => str_contains($exception->getMessage(), 'cannot be reached'));
        $this->assertSame([], $this->sockets->terminated);
        $this->assertSame(2, PendingSocketCut::query()->where('attempts', 1)->count(), 'one retry per tag');

        $this->sockets->recover();
        Artisan::call('chat:realtime-sweep');
        $this->assertSame([], $this->sockets->terminated, 'not due yet');

        $this->travel(6)->seconds();
        Artisan::call('chat:realtime-sweep');

        $this->assertCut($agent);
        $this->assertSame(0, PendingSocketCut::query()->count());
    }

    public function test_a_cut_that_keeps_failing_backs_off_and_is_finally_given_up(): void
    {
        Exceptions::fake();
        $agent = User::factory()->agent()->create();
        $this->sockets->failWith();
        app(SocketCutOff::class)->cutStaff($agent->id, 'test');

        for ($round = 0; $round < SocketCutOff::MAX_ATTEMPTS + 2; $round++) {
            $this->travel(11)->minutes();
            Artisan::call('chat:realtime-sweep');
        }

        $this->assertSame(0, PendingSocketCut::query()->count());
        Exceptions::assertReported(fn (\RuntimeException $exception): bool => str_contains($exception->getMessage(), 'was given up'));
    }

    public function test_every_cut_is_repeated_once_after_the_follow_up_pause(): void
    {
        $agent = User::factory()->agent()->create();

        app(SocketCutOff::class)->cutStaff($agent->id, 'test');
        $this->assertSame(1, $this->sockets->count(SocketTags::staff($agent->id)));
        $this->assertSame(2, PendingSocketCut::query()->count());

        $this->travel(SocketCutOff::FOLLOW_UP_SECONDS - 1)->seconds();
        Artisan::call('chat:realtime-sweep');
        $this->assertSame(1, $this->sockets->count(SocketTags::staff($agent->id)));

        $this->travel(2)->seconds();
        Artisan::call('chat:realtime-sweep');

        $this->assertSame(2, $this->sockets->count(SocketTags::staff($agent->id)));
        $this->assertSame(0, PendingSocketCut::query()->count());
    }

    public function test_parked_rows_of_one_tag_cost_one_call_per_sweep(): void
    {
        $agent = User::factory()->agent()->create();
        $cutoff = app(SocketCutOff::class);
        $cutoff->cutStaff($agent->id, 'one');
        $cutoff->cutStaff($agent->id, 'two');
        $cutoff->cutStaff($agent->id, 'three');
        $this->sockets->reset();

        $this->travel(30)->seconds();
        Artisan::call('chat:realtime-sweep');

        $this->assertSame(1, $this->sockets->count(SocketTags::staff($agent->id)));
        $this->assertSame(0, PendingSocketCut::query()->count());
    }

    public function test_a_database_that_cannot_park_the_follow_up_does_not_fail_the_caller(): void
    {
        Exceptions::fake();
        $agent = User::factory()->agent()->create();
        Schema::drop('socket_cutoffs');

        app(SocketCutOff::class)->cutStaff($agent->id, 'test');

        $this->assertCut($agent);
        Exceptions::assertReported(QueryException::class);
    }

    public function test_the_presence_status_of_an_agent_does_not_matter_to_the_cut(): void
    {
        $agent = $this->availableAgent(Category::factory()->create(), [], PresenceStatus::Away);

        $agent->forceFill(['is_active' => false])->save();

        $this->assertCut($agent);
    }

    public function test_the_recording_broadcaster_stays_out_of_the_cut(): void
    {
        $wire = $this->recordBroadcasts();
        $this->assertInstanceOf(RecordingBroadcaster::class, $wire);
        $agent = User::factory()->agent()->create();

        $agent->forceFill(['is_active' => false])->save();

        $this->assertSame([], $wire->published, 'closing a socket publishes nothing');
    }
}
