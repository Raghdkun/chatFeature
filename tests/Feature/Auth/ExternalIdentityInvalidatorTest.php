<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Pizzasys\ExternalIdentityInvalidator;
use App\Auth\Support\SessionContext;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * The contract track 2B (NATS consumer) relies on: flush one identity, deactivate one, flush everything.
 */
class ExternalIdentityInvalidatorTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    private IdentityInvalidator $invalidator;

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()
            ->user('agent@test.local', 'pw', 'agent', 'Agent One')
            ->user('second@test.local', 'pw', 'agent', 'Agent Two')
            ->fake();
        $this->invalidator = app(IdentityInvalidator::class);
    }

    /**
     * @return array{0: User, 1: ExternalSession, 2: SessionContext}
     */
    private function signedIn(string $email): array
    {
        $result = app(AuthDriver::class)->attemptForApi(['email' => $email, 'password' => 'pw'], 'phone');
        $session = ExternalSession::query()->where('user_id', $result->user->id)->latest('id')->firstOrFail();

        return [$result->user, $session, new SessionContext(null, null, null, null, $session->sanctum_token_id)];
    }

    public function test_the_container_hands_out_the_database_backed_implementation(): void
    {
        $this->assertInstanceOf(ExternalIdentityInvalidator::class, $this->invalidator);
    }

    public function test_flushing_an_identity_forces_a_live_verification_on_its_next_request(): void
    {
        [$user, $session, $context] = $this->signedIn('agent@test.local');
        $driver = app(AuthDriver::class);
        $this->assertSame(SessionVerdict::Fresh, $driver->validateSession($user, $context));
        $verifies = $this->portal->calls('token-verify');

        $this->invalidator->flushForExternalId($this->portal->idFor('agent@test.local'));

        $identity = UserExternalIdentity::query()->where('user_id', $user->id)->sole();
        $this->assertNotNull($identity->stale_at);
        $this->assertSame(SessionVerdict::Revalidated, $driver->validateSession($user, $context));
        $this->assertSame($verifies + 1, $this->portal->calls('token-verify'));
        $this->assertNull($identity->refresh()->stale_at);
    }

    public function test_flushing_one_identity_leaves_the_others_cached(): void
    {
        [$a, , $contextA] = $this->signedIn('agent@test.local');
        [$b, , $contextB] = $this->signedIn('second@test.local');
        $driver = app(AuthDriver::class);

        $this->invalidator->flushForExternalId($this->portal->idFor('agent@test.local'));

        $this->assertSame(SessionVerdict::Fresh, $driver->validateSession($b, $contextB));
        $this->assertSame(SessionVerdict::Revalidated, $driver->validateSession($a, $contextA));
    }

    public function test_flushing_an_unknown_id_does_nothing(): void
    {
        $this->signedIn('agent@test.local');

        $this->invalidator->flushForExternalId('999999');
        $this->invalidator->flushForExternalId('');

        $this->assertSame(0, UserExternalIdentity::query()->whereNotNull('stale_at')->count());
    }

    public function test_deactivating_an_identity_revokes_everything_and_blocks_the_user(): void
    {
        [$user, $session, $context] = $this->signedIn('agent@test.local');
        $this->signedIn('agent@test.local'); // a second device
        $this->assertSame(2, PersonalAccessToken::query()->count());

        $this->invalidator->deactivateExternalId($this->portal->idFor('agent@test.local'));

        $user->refresh();
        $this->assertFalse($user->is_active);
        $identity = UserExternalIdentity::query()->where('user_id', $user->id)->sole();
        $this->assertNotNull($identity->deactivated_at);
        $this->assertFalse($identity->active);
        $this->assertSame(0, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertSame(0, PersonalAccessToken::query()->count());
        $this->assertSame(SessionVerdict::Revoked, app(AuthDriver::class)->validateSession($user, $context));
        $this->assertDatabaseHas('audit_logs', ['action' => 'auth.identity_deactivated', 'subject_id' => (string) $user->id]);
    }

    public function test_a_deactivated_person_cannot_sign_in_again(): void
    {
        $this->signedIn('agent@test.local');
        $this->invalidator->deactivateExternalId($this->portal->idFor('agent@test.local'));

        $result = app(AuthDriver::class)->attempt(Request::create('/login', 'POST', ['email' => 'agent@test.local', 'password' => 'pw']));

        $this->assertFalse($result->isOk());
        $this->assertStringContainsString('deactivated', (string) $result->message);
    }

    public function test_deactivation_only_touches_the_active_environment(): void
    {
        $testing = $this->useTestingEnvironment();
        $user = User::factory()->agent()->create(['auth_source' => 'pizzasys']);
        $other = UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $testing->id, 'external_id' => '77']);

        $this->invalidator->deactivateExternalId('77');

        $this->assertNull($other->refresh()->deactivated_at, 'portal id 77 of the testing portal is a different person');
        $this->assertTrue($user->refresh()->is_active);
    }

    public function test_deactivating_twice_is_harmless(): void
    {
        [$user] = $this->signedIn('agent@test.local');

        $this->invalidator->deactivateExternalId($this->portal->idFor('agent@test.local'));
        $this->invalidator->deactivateExternalId($this->portal->idFor('agent@test.local'));

        $this->assertFalse($user->refresh()->is_active);
    }

    public function test_flushing_everything_marks_every_identity_stale_and_drops_the_caches(): void
    {
        [$a, , $contextA] = $this->signedIn('agent@test.local');
        [$b, , $contextB] = $this->signedIn('second@test.local');
        $driver = app(AuthDriver::class);
        $this->assertSame(SessionVerdict::Fresh, $driver->validateSession($a, $contextA));

        $this->invalidator->flushAll();

        $this->assertSame(2, UserExternalIdentity::query()->whereNotNull('stale_at')->count());
        $this->assertSame(SessionVerdict::Revalidated, $driver->validateSession($a, $contextA));
        $this->assertSame(SessionVerdict::Revalidated, $driver->validateSession($b, $contextB));
        $this->assertSame(0, UserExternalIdentity::query()->whereNotNull('stale_at')->count());
    }

    public function test_role_changes_are_picked_up_after_a_flush(): void
    {
        [$user, , $context] = $this->signedIn('agent@test.local');
        $this->portal->claims('agent@test.local', ['super-admin'], []);

        $this->invalidator->flushAll();
        app(AuthDriver::class)->validateSession($user, $context);

        $this->assertTrue($user->refresh()->is_admin);
        $this->assertInstanceOf(AuthEnvironment::class, UserExternalIdentity::query()->first()->environment);
    }
}
