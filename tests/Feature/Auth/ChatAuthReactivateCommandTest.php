<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * `chat:auth:reactivate`: the ops way back from a (possibly mistaken or forged) upstream `user.deleted`.
 */
class ChatAuthReactivateCommandTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()->user('agent@test.local', 'pw', 'agent', 'Agent One')->fake();
    }

    /** Sign in once, then let the portal "delete" the account (the NATS handler's call). */
    private function deactivated(): UserExternalIdentity
    {
        app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'pw'], 'phone');
        app(IdentityInvalidator::class)->deactivateExternalId($this->portal->idFor('agent@test.local'));

        return UserExternalIdentity::query()->sole();
    }

    public function test_a_wrongly_deactivated_account_can_sign_in_again_after_reactivation_by_email(): void
    {
        $identity = $this->deactivated();
        $this->assertFalse(app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'pw'], 'phone')->isOk());

        $this->artisan('chat:auth:reactivate', ['who' => 'AGENT@test.local', '--force' => true])
            ->expectsOutputToContain('Reactivated portal user '.$identity->external_id)
            ->assertSuccessful();

        $identity->refresh();
        $this->assertNull($identity->deactivated_at);
        $this->assertTrue($identity->active);
        $this->assertNotNull($identity->stale_at, 'roles are re-verified on the next request');
        $this->assertTrue(app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'pw'], 'phone')->isOk());

        $row = AuditLog::query()->where('action', 'auth.identity_reactivated')->sole();
        $this->assertNull($row->actor_id);
        $this->assertSame('cli', $row->changes['via']);
        $this->assertSame($identity->external_id, $row->changes['external_id']);
    }

    public function test_it_works_by_portal_user_id_and_for_the_testing_environment(): void
    {
        $identity = $this->deactivated();
        $testing = $this->useTestingEnvironment();
        $user = User::factory()->agent()->create(['auth_source' => 'pizzasys']);
        $other = UserExternalIdentity::factory()->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $testing->id, 'external_id' => '905']);

        $this->artisan('chat:auth:reactivate', ['who' => '905', '--env' => 'testing', '--force' => true])->assertSuccessful();
        $this->assertNull($other->refresh()->deactivated_at);

        $this->artisan('chat:auth:reactivate', ['who' => $identity->external_id, '--force' => true])->assertSuccessful();
        $this->assertNull($identity->refresh()->deactivated_at);
    }

    public function test_it_also_reactivates_a_user_older_versions_deactivated_along_with_the_identity(): void
    {
        $identity = $this->deactivated();
        $identity->user->forceFill(['is_active' => false])->save();

        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--force' => true])->assertSuccessful();

        $this->assertTrue($identity->user->refresh()->is_active);
    }

    public function test_it_asks_for_confirmation_unless_forced(): void
    {
        $identity = $this->deactivated();

        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local'])
            ->expectsConfirmation('Reactivate portal user '.$identity->external_id.' in the production environment so they can sign in again?', 'no')
            ->assertFailed();
        $this->assertNotNull($identity->refresh()->deactivated_at);

        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local'])
            ->expectsConfirmation('Reactivate portal user '.$identity->external_id.' in the production environment so they can sign in again?', 'yes')
            ->assertSuccessful();
        $this->assertNull($identity->refresh()->deactivated_at);
    }

    public function test_it_refuses_when_nothing_matches(): void
    {
        $this->deactivated();

        $this->artisan('chat:auth:reactivate', ['who' => 'nobody@test.local', '--force' => true])->assertFailed();
        $this->artisan('chat:auth:reactivate', ['who' => '999999', '--force' => true])->assertFailed();
        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--env' => 'staging', '--force' => true])->assertFailed();
        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--env' => 'testing', '--force' => true])->assertFailed();
    }

    public function test_it_refuses_while_the_person_has_another_live_account_in_that_environment(): void
    {
        $old = $this->deactivated();
        $this->portal->user('agent@test.local', 'new-pw', 'agent', 'Agent One Again');
        $this->assertTrue(app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'new-pw'], 'phone')->isOk());

        $this->artisan('chat:auth:reactivate', ['who' => $old->external_id, '--force' => true])
            ->expectsOutputToContain('already has a live account')
            ->assertFailed();

        $this->assertNotNull($old->refresh()->deactivated_at);
        $this->assertSame(1, UserExternalIdentity::query()->whereNull('deactivated_at')->count());
    }

    public function test_an_ambiguous_email_asks_for_the_portal_user_id(): void
    {
        $first = $this->deactivated();
        $this->portal->user('agent@test.local', 'new-pw', 'agent');
        app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'new-pw'], 'phone');
        app(IdentityInvalidator::class)->deactivateExternalId($this->portal->idFor('agent@test.local'));

        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--force' => true])
            ->expectsOutputToContain('More than one deactivated identity')
            ->assertFailed();

        $this->artisan('chat:auth:reactivate', ['who' => $first->external_id, '--force' => true])->assertSuccessful();
    }

    public function test_it_does_nothing_outside_mode_two_or_before_install(): void
    {
        settings()->set('auth.mode', 'fortify');
        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--force' => true])->assertFailed();

        settings()->set('auth.mode', 'pizzasys');
        InstallStateFake::make(installed: false);
        $this->artisan('chat:auth:reactivate', ['who' => 'agent@test.local', '--force' => true])->assertFailed();
    }
}
