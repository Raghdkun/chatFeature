<?php

namespace Tests\Feature\Realtime;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Pizzasys\ExternalSessionStore;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Auth\Roles\RoleDecision;
use App\Auth\Support\SessionContext;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Models\ExternalSession;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InteractsWithPortal;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\PizzasysMock;
use Tests\Support\RecordingBroadcaster;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Every place a staff session ends, a role is removed or an account is deactivated dispatches `StaffSessionRevoked` (the Chat context
 * requeues the agent's chats from it, the client drops its session): the mode-1 agent API, the portal session store, role resolution
 * and the NATS `user.deleted` handler.
 */
class StaffSessionRevokedHooksTest extends TestCase
{
    use InteractsWithPortal, InteractsWithRealtime, RefreshDatabase, WidgetFixtures;

    /**
     * @return list<array{int, SessionRevokeReason}>
     */
    private function dispatched(): array
    {
        $found = [];

        Event::assertDispatched(StaffSessionRevoked::class, function (StaffSessionRevoked $event) use (&$found): bool {
            $found[] = [$event->userId, $event->reason];

            return true;
        });

        return $found;
    }

    // ---- mode 1: the agent API (UpdateAgent) -------------------------------------------------------------------------------

    private function patchAgent(User $target, array $body): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')->patchJson('/api/v1/agents/'.$target->id, $body)->assertOk();
    }

    public function test_deactivating_an_agent_announces_it(): void
    {
        $this->useFortifyMode();
        $agent = User::factory()->agent()->create();
        Event::fake([StaffSessionRevoked::class]);

        $this->patchAgent($agent, ['is_active' => false]);

        $this->assertSame([[$agent->id, SessionRevokeReason::Deactivated]], $this->dispatched());
    }

    public function test_an_admin_who_stops_taking_chats_announces_a_removed_role(): void
    {
        $this->useFortifyMode();
        $admin = User::factory()->admin()->create();
        Event::fake([StaffSessionRevoked::class]);

        $this->patchAgent($admin, ['is_agent' => false]);

        $this->assertSame([[$admin->id, SessionRevokeReason::RoleRemoved]], $this->dispatched());
    }

    public function test_deactivating_and_dropping_the_agent_role_at_once_announces_the_deactivation_only(): void
    {
        $this->useFortifyMode();
        $admin = User::factory()->admin()->create();
        Event::fake([StaffSessionRevoked::class]);

        $this->patchAgent($admin, ['is_active' => false, 'is_agent' => false]);

        $this->assertSame([[$admin->id, SessionRevokeReason::Deactivated]], $this->dispatched());
    }

    public function test_edits_that_take_nothing_away_announce_nothing(): void
    {
        $this->useFortifyMode();
        $inactive = User::factory()->agent()->inactive()->create();
        $agent = User::factory()->agent()->create();
        $admin = User::factory()->admin()->state(['is_agent' => false])->create();
        Event::fake([StaffSessionRevoked::class]);

        $this->patchAgent($agent, ['max_concurrent_chats' => 9]);
        $this->patchAgent($agent, ['max_concurrent_chats' => 9]);
        $this->patchAgent($inactive, ['is_active' => true]);
        $this->patchAgent($admin, ['is_agent' => true]);

        Event::assertNotDispatched(StaffSessionRevoked::class);
    }

    public function test_a_refused_deactivation_announces_nothing(): void
    {
        $this->useFortifyMode();
        $admin = User::factory()->admin()->create();
        Event::fake([StaffSessionRevoked::class]);

        $this->actingAs($admin, 'sanctum')->patchJson('/api/v1/agents/'.$admin->id, ['is_active' => false])->assertStatus(409);

        Event::assertNotDispatched(StaffSessionRevoked::class);
    }

    // ---- mode 2: the portal session store ----------------------------------------------------------------------------------

    private function liveSession(): ExternalSession
    {
        $this->usePortalMode();
        PizzasysMock::make()->fake();
        $identity = UserExternalIdentity::factory()->create();

        return ExternalSession::factory()->create(['identity_id' => $identity->id]);
    }

    /**
     * @return iterable<string, array{string, SessionRevokeReason|null}>
     */
    public static function portalRevocations(): iterable
    {
        yield 'account deactivated' => ['deactivated', SessionRevokeReason::Deactivated];
        yield 'upstream says the token is dead' => ['upstream_inactive', SessionRevokeReason::AuthRevoked];
        yield 'identity mismatch' => ['identity_mismatch', SessionRevokeReason::AuthRevoked];
        yield 'token missing' => ['token_missing', SessionRevokeReason::AuthRevoked];
        yield 'environment switched' => ['environment_switched', SessionRevokeReason::AuthRevoked];
        yield 'a reason nobody planned for' => ['something_new', SessionRevokeReason::AuthRevoked];
        yield 'the person signed out' => ['logout', null];
        yield 'an abandoned session was swept' => ['expired', null];
        yield 'role removed (announced where the role is removed)' => ['no_chat_access', null];
        yield 'deleted upstream (announced per identity)' => ['upstream_deleted', null];
    }

    #[DataProvider('portalRevocations')]
    public function test_revoking_a_portal_session_announces_the_unrequested_reasons(string $reason, ?SessionRevokeReason $announced): void
    {
        $session = $this->liveSession();
        Event::fake([StaffSessionRevoked::class]);

        app(ExternalSessionStore::class)->revoke($session, $reason);

        if ($announced === null) {
            Event::assertNotDispatched(StaffSessionRevoked::class);
        } else {
            $this->assertSame([[$session->user_id, $announced]], $this->dispatched());
        }
    }

    public function test_revoking_twice_announces_once(): void
    {
        $session = $this->liveSession();
        Event::fake([StaffSessionRevoked::class]);

        app(ExternalSessionStore::class)->revoke($session, 'upstream_inactive');
        app(ExternalSessionStore::class)->revoke($session->fresh(), 'upstream_inactive');

        Event::assertDispatchedTimes(StaffSessionRevoked::class, 1);
    }

    public function test_switching_the_active_environment_tells_every_signed_in_person(): void
    {
        $this->usePortalMode();
        PizzasysMock::make()->fake();
        $a = ExternalSession::factory()->create(['identity_id' => UserExternalIdentity::factory()->create()->id]);
        $b = ExternalSession::factory()->create(['identity_id' => UserExternalIdentity::factory()->create()->id]);
        $testing = $this->useTestingEnvironment();
        Event::fake([StaffSessionRevoked::class]);

        app(ExternalSessionStore::class)->revokeOutsideEnvironment((int) $testing->getKey(), 'environment_switched');

        $this->assertEqualsCanonicalizing(
            [[$a->user_id, SessionRevokeReason::AuthRevoked], [$b->user_id, SessionRevokeReason::AuthRevoked]],
            $this->dispatched(),
        );
    }

    // ---- mode 2 end to end: the driver judging a request -------------------------------------------------------------------

    /**
     * @return array{0: User, 1: SessionContext, 2: PizzasysMock}
     */
    private function signedInThroughThePortal(): array
    {
        $this->usePortalMode();
        $portal = PizzasysMock::make()->user('agent@test.local', 'pw', 'agent', 'Agent One')->fake();
        $result = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'pw'], 'phone');
        $session = ExternalSession::query()->where('user_id', $result->user->id)->latest('id')->firstOrFail();

        return [$result->user, new SessionContext(null, '127.0.0.1', 'phpunit', null, $session->sanctum_token_id), $portal];
    }

    public function test_a_token_the_portal_no_longer_knows_ends_the_session_and_announces_it(): void
    {
        [$user, $context, $portal] = $this->signedInThroughThePortal();
        $portal->revoke('agent@test.local');
        $this->travel(2)->minutes();
        Event::fake([StaffSessionRevoked::class]);

        $this->assertSame(SessionVerdict::Revoked, app(AuthDriver::class)->validateSession($user, $context));

        $this->assertSame([[$user->id, SessionRevokeReason::AuthRevoked]], $this->dispatched());
    }

    public function test_losing_the_chat_role_upstream_announces_a_removed_role_exactly_once(): void
    {
        [$user, $context, $portal] = $this->signedInThroughThePortal();
        $portal->claims('agent@test.local', [], []);
        $this->travel(2)->minutes();
        Event::fake([StaffSessionRevoked::class]);

        $this->assertSame(SessionVerdict::Revoked, app(AuthDriver::class)->validateSession($user, $context));

        $this->assertSame([[$user->id, SessionRevokeReason::RoleRemoved]], $this->dispatched());
    }

    public function test_a_deactivated_account_ends_the_session_and_announces_it(): void
    {
        [$user, $context] = $this->signedInThroughThePortal();
        $user->forceFill(['is_active' => false])->saveQuietly();
        Event::fake([StaffSessionRevoked::class]);

        $this->assertSame(SessionVerdict::Revoked, app(AuthDriver::class)->validateSession($user->refresh(), $context));

        $this->assertSame([[$user->id, SessionRevokeReason::Deactivated]], $this->dispatched());
    }

    public function test_a_session_that_was_already_revoked_announces_nothing_again(): void
    {
        [$user, $context] = $this->signedInThroughThePortal();
        ExternalSession::query()->where('user_id', $user->id)->update(['revoked_at' => now()]);
        Event::fake([StaffSessionRevoked::class]);

        $this->assertSame(SessionVerdict::Revoked, app(AuthDriver::class)->validateSession($user, $context));

        Event::assertNotDispatched(StaffSessionRevoked::class);
    }

    public function test_a_portal_outage_never_announces_a_revocation(): void
    {
        [$user, $context, $portal] = $this->signedInThroughThePortal();
        $portal->outage('down');
        $this->travel(2)->minutes();
        Event::fake([StaffSessionRevoked::class]);

        app(AuthDriver::class)->validateSession($user, $context);

        Event::assertNotDispatched(StaffSessionRevoked::class);
    }

    // ---- mode 2: roles ----------------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{array{bool, bool}, array{bool, bool}, SessionRevokeReason|null}>
     */
    public static function roleChanges(): iterable
    {
        yield 'agent loses the role' => [[false, true], [false, false], SessionRevokeReason::RoleRemoved];
        yield 'admin loses everything' => [[true, true], [false, false], SessionRevokeReason::RoleRemoved];
        yield 'admin stays an agent' => [[true, true], [false, true], SessionRevokeReason::AuthRevoked];
        yield 'agent is promoted' => [[false, true], [true, true], null];
        yield 'nothing changes' => [[false, true], [false, true], null];
        yield 'somebody without a role gains one' => [[false, false], [false, true], null];
    }

    /**
     * @param  array{bool, bool}  $before  [is_admin, is_agent]
     * @param  array{bool, bool}  $after
     */
    #[DataProvider('roleChanges')]
    public function test_a_demotion_in_the_portal_announces_what_it_takes_away(array $before, array $after, ?SessionRevokeReason $announced): void
    {
        $user = User::factory()->create(['auth_source' => 'pizzasys', 'password' => null, 'is_admin' => $before[0], 'is_agent' => $before[1]]);
        Event::fake([StaffSessionRevoked::class]);

        app(PizzasysRoleResolver::class)->apply($user, new RoleDecision($after[0], $after[1]));

        if ($announced === null) {
            Event::assertNotDispatched(StaffSessionRevoked::class);
        } else {
            $this->assertSame([[$user->id, $announced]], $this->dispatched());
        }

        $this->assertSame($after, [$user->refresh()->is_admin, $user->is_agent]);
    }

    // ---- mode 2: NATS user.deleted -----------------------------------------------------------------------------------------

    public function test_an_account_deleted_upstream_announces_one_deactivation_per_identity_even_without_sessions(): void
    {
        $this->usePortalMode();
        PizzasysMock::make()->fake();
        $identity = UserExternalIdentity::factory()->create();
        ExternalSession::factory()->count(2)->create(['identity_id' => $identity->id]);
        $idleIdentity = UserExternalIdentity::factory()->create();
        Event::fake([StaffSessionRevoked::class]);

        app(IdentityInvalidator::class)->deactivateExternalId($identity->external_id);
        app(IdentityInvalidator::class)->deactivateExternalId($idleIdentity->external_id);
        app(IdentityInvalidator::class)->deactivateExternalId($identity->external_id);

        $this->assertEqualsCanonicalizing(
            [[$identity->user_id, SessionRevokeReason::Deactivated], [$idleIdentity->user_id, SessionRevokeReason::Deactivated]],
            $this->dispatched(),
        );
    }

    public function test_an_account_the_portal_does_not_know_announces_nothing(): void
    {
        $this->usePortalMode();
        Event::fake([StaffSessionRevoked::class]);

        app(IdentityInvalidator::class)->deactivateExternalId('424242');

        Event::assertNotDispatched(StaffSessionRevoked::class);
    }

    // ---- the announcement reaches the staff channel ------------------------------------------------------------------------

    public function test_the_announcement_becomes_a_session_revoked_message_on_that_staff_channel(): void
    {
        $this->useFortifyMode();
        $wire = $this->recordBroadcasts();
        $agent = User::factory()->agent()->create();

        $this->patchAgent($agent, ['is_active' => false]);

        $this->assertInstanceOf(RecordingBroadcaster::class, $wire);
        $this->assertSame(['private-staff.'.$agent->id], $wire->sole('session.revoked')['channels']);
        $this->assertSame(['v' => 1, 'reason' => 'deactivated'], $wire->sole('session.revoked')['payload']);
    }
}
