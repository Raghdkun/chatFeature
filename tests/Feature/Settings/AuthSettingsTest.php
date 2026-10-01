<?php

namespace Tests\Feature\Settings;

use App\Auth\Pizzasys\PortalHealth;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Settings > Auth (docs/contracts/auth-pizzasys.md): admin only, secrets write-only, mode 1 shows "managed by this app".
 */
class AuthSettingsTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()
            ->user('admin@test.local', 'pw', 'admin', 'Prod Admin')
            ->user('agent@test.local', 'pw', 'agent', 'Prod Agent')
            ->user('chatadmin@test.local', 'pw', 'chatadmin', 'Chat Admin')
            ->fake();
    }

    private function signIn(string $email = 'admin@test.local'): void
    {
        $this->post(route('login.store'), ['email' => $email, 'password' => 'pw'])->assertRedirect(route('dashboard', absolute: false));
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function environmentPayload(array $overrides = []): array
    {
        return [
            'label' => 'Production',
            'base_url' => PizzasysMock::BASE_URL,
            'service_name' => PizzasysMock::SERVICE_NAME,
            'nats_url' => null,
            'verify_tls' => true,
            ...$overrides,
        ];
    }

    public function test_a_rejected_environment_form_does_not_flash_its_tokens_into_the_session(): void
    {
        $this->signIn();

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload([
            'base_url' => 'ftp://x',
            'service_token' => 'brand-new-service-token',
            'nats_url' => 'nats://nats.example.test:4222',
            'nats_token' => 'brand-new-nats-token',
        ]))->assertSessionHasErrors('base_url');

        $old = session()->getOldInput();
        $this->assertSame('ftp://x', $old['base_url'] ?? null, 'the rest of the input is still given back');

        $flashed = (string) json_encode($old);
        $this->assertStringNotContainsString('brand-new-service-token', $flashed);
        $this->assertStringNotContainsString('brand-new-nats-token', $flashed);
    }

    // ---- authorization ------------------------------------------------------------------------------------------

    public function test_guests_are_sent_to_the_login_page(): void
    {
        $this->get(route('settings.auth.edit'))->assertRedirect(route('login'));
        $this->putJson(route('settings.auth.environments.update', 'production'), $this->environmentPayload())->assertUnauthorized();
        $this->postJson(route('settings.auth.environments.test', 'production'))->assertUnauthorized();
        $this->postJson(route('settings.auth.active-environment'))->assertUnauthorized();
        $this->putJson(route('settings.auth.roles.update'), [])->assertUnauthorized();
    }

    public function test_agents_get_403_on_every_endpoint(): void
    {
        $this->signIn('agent@test.local');

        $this->get(route('settings.auth.edit'))->assertForbidden();
        $this->putJson(route('settings.auth.environments.update', 'production'), $this->environmentPayload())->assertForbidden();
        $this->postJson(route('settings.auth.environments.test', 'production'))->assertForbidden();
        $this->postJson(route('settings.auth.active-environment'), ['env' => 'testing'])->assertForbidden();
        $this->putJson(route('settings.auth.roles.update'), ['admin_permission' => 'x', 'agent_permission' => 'y', 'super_roles' => []])->assertForbidden();
        $this->assertSame(1, $this->portal->calls('login'), 'only the agent\'s own sign-in reached the portal');
    }

    public function test_a_revoked_admin_session_cannot_reach_the_page(): void
    {
        $this->signIn();
        $this->portal->revoke('admin@test.local');
        $this->travel(2)->minutes();

        $this->get(route('settings.auth.edit'))->assertRedirect(route('login'));
    }

    // ---- the page -----------------------------------------------------------------------------------------------

    public function test_the_page_props_follow_the_contract_and_carry_no_secret(): void
    {
        AuthEnvironment::query()->where('key', 'production')->update(['nats_url' => 'nats://nats.example.test:4222']);
        AuthEnvironment::query()->first()->forceFill(['nats_token' => 'nats-secret-value', 'last_check_status' => 'ok', 'last_check_at' => now()])->save();
        $this->signIn();

        $response = $this->get(route('settings.auth.edit'));

        $response->assertInertia(fn (Assert $page) => $page
            ->component('settings/auth')
            ->where('authSettings.mode', 'pizzasys')
            ->where('authSettings.active_env', 'production')
            ->has('authSettings.environments', 2)
            ->where('authSettings.environments.0.key', 'production')
            ->where('authSettings.environments.0.configured', true)
            ->where('authSettings.environments.0.base_url', PizzasysMock::BASE_URL)
            ->where('authSettings.environments.0.service_name', PizzasysMock::SERVICE_NAME)
            ->where('authSettings.environments.0.has_service_token', true)
            ->where('authSettings.environments.0.nats_url', 'nats://nats.example.test:4222')
            ->where('authSettings.environments.0.has_nats_token', true)
            ->where('authSettings.environments.0.verify_tls', true)
            ->where('authSettings.environments.0.last_check_status', 'ok')
            ->where('authSettings.environments.1.key', 'testing')
            ->where('authSettings.environments.1.configured', false)
            ->where('authSettings.environments.1.has_service_token', false)
            ->where('authSettings.roles', ['admin_permission' => 'chat.admin', 'agent_permission' => 'chat.agent', 'super_roles' => ['super-admin']])
            ->where('authSettings.health.portal', 'ok')
            ->where('authSettings.health.circuit_open', false)
            ->where('authSettings.health.service_credential_rejected', false)
            ->where('authSettings.health.nats', ['enabled' => false, 'connected' => null, 'last_event_at' => null]));

        $json = (string) json_encode($response->inertiaProps());
        foreach ([PizzasysMock::SERVICE_TOKEN, 'nats-secret-value', '"service_token"', '"nats_token"', 'token_encrypted', $this->portal->tokenFor('admin@test.local')] as $secret) {
            $this->assertStringNotContainsString($secret, $json);
        }
    }

    public function test_the_health_card_shows_the_portal_state_and_the_nats_heartbeat(): void
    {
        settings()->set('auth.pizzasys.nats.enabled', true);
        $this->signIn();
        $this->portal->rejectServiceCredential();
        $this->travel(2)->minutes();
        $this->get(route('dashboard')); // a revalidation hits the rejected credential
        Cache::put('auth.nats.heartbeat_at', now()->toIso8601String());
        Cache::put('auth.nats.connected', true);
        Cache::put('auth.nats.last_event_at', '2026-10-21T10:00:00+00:00');

        $this->get(route('settings.auth.edit'))->assertInertia(fn (Assert $page) => $page
            ->where('authSettings.health.portal', 'degraded')
            ->where('authSettings.health.service_credential_rejected', true)
            ->where('authSettings.health.nats', ['enabled' => true, 'connected' => true, 'last_event_at' => '2026-10-21T10:00:00+00:00']));
    }

    public function test_mode_one_shows_the_page_without_anything_to_edit(): void
    {
        settings()->set('auth.mode', 'fortify');
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin)->get(route('settings.auth.edit'))->assertInertia(fn (Assert $page) => $page
            ->component('settings/auth')
            ->where('authSettings.mode', 'fortify')
            ->where('authSettings.environments', [])
            ->where('authSettings.health.portal', 'unknown'));

        $this->actingAs($admin)->putJson(route('settings.auth.environments.update', 'production'), $this->environmentPayload())->assertNotFound();
        $this->actingAs($admin)->postJson(route('settings.auth.environments.test', 'production'))->assertNotFound();
        $this->actingAs($admin)->putJson(route('settings.auth.roles.update'), ['admin_permission' => 'a', 'agent_permission' => 'b', 'super_roles' => []])->assertNotFound();
    }

    public function test_mode_one_answers_404_before_the_payload_is_validated(): void
    {
        settings()->set('auth.mode', 'fortify');
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin)->putJson(route('settings.auth.environments.update', 'production'), [])->assertNotFound();
        $this->actingAs($admin)->postJson(route('settings.auth.active-environment'), [])->assertNotFound();
        $this->actingAs($admin)->putJson(route('settings.auth.roles.update'), [])->assertNotFound();
    }

    public function test_agents_in_mode_one_are_still_refused(): void
    {
        settings()->set('auth.mode', 'fortify');

        $this->actingAs(User::factory()->agent()->create())->get(route('settings.auth.edit'))->assertForbidden();
    }

    // ---- environments -------------------------------------------------------------------------------------------

    public function test_saving_without_a_token_keeps_the_stored_service_token(): void
    {
        $this->signIn();
        $stored = AuthEnvironment::query()->where('key', 'production')->sole()->service_token_encrypted;
        $verifies = $this->portal->calls('token-verify');

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload(['label' => 'Live']))->assertRedirect();

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('Live', $environment->label);
        $this->assertSame($stored, $environment->service_token_encrypted);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $environment->service_token);
        $this->assertSame($verifies, $this->portal->calls('token-verify'), 'a label change does not call the portal');
    }

    public function test_a_new_token_replaces_the_old_one_and_is_stored_encrypted(): void
    {
        $this->signIn();
        $this->portal->acceptServiceToken('brand-new-service-token');

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload(['service_token' => 'brand-new-service-token']))->assertRedirect();

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('brand-new-service-token', $environment->service_token);
        $this->assertStringNotContainsString('brand-new-service-token', $environment->service_token_encrypted);
        $this->assertDatabaseMissing('auth_environments', ['service_token_encrypted' => 'brand-new-service-token']);
    }

    public function test_the_nats_token_can_be_set_kept_and_cleared(): void
    {
        $this->signIn();
        $url = route('settings.auth.environments.update', 'production');

        $this->put($url, $this->environmentPayload(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'first-nats-token']))->assertRedirect();
        $this->assertSame('first-nats-token', AuthEnvironment::query()->where('key', 'production')->sole()->nats_token);

        $this->put($url, $this->environmentPayload(['nats_url' => 'nats://nats.example.test:4222']))->assertRedirect();
        $this->assertSame('first-nats-token', AuthEnvironment::query()->where('key', 'production')->sole()->nats_token, 'omitted = kept');

        $this->put($url, $this->environmentPayload(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => null]))->assertRedirect();
        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertNull($environment->nats_token, 'null = cleared');
        $this->assertFalse($environment->hasNatsToken());
    }

    public function test_clearing_the_nats_url_clears_its_token_too(): void
    {
        $this->signIn();
        $url = route('settings.auth.environments.update', 'production');
        $this->put($url, $this->environmentPayload(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'a-nats-token']))->assertRedirect();

        $this->put($url, $this->environmentPayload(['nats_url' => null]))->assertRedirect();

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertNull($environment->nats_url);
        $this->assertFalse($environment->hasNatsToken());
        $this->assertFalse(settings('auth.pizzasys.nats.enabled'));
    }

    public function test_the_testing_environment_can_be_added_but_needs_a_token(): void
    {
        $this->signIn();
        $url = route('settings.auth.environments.update', 'testing');
        $payload = $this->environmentPayload(['label' => 'Testing', 'base_url' => 'https://auth-testing.example.test']);

        $this->putJson($url, $payload)->assertStatus(422)->assertJsonValidationErrors('service_token');
        $this->assertSame(0, AuthEnvironment::query()->where('key', 'testing')->count());

        $this->putJson($url, [...$payload, 'service_token' => 'testing-service-token'])->assertRedirect();

        $testing = AuthEnvironment::query()->where('key', 'testing')->sole();
        $this->assertSame('https://auth-testing.example.test', $testing->base_url);
        $this->assertSame('testing-service-token', $testing->service_token);
        $this->assertSame('production', settings('auth.pizzasys.active_env'), 'adding an environment never activates it');
        $this->assertDatabaseHas('audit_logs', ['action' => 'auth.environment_created']);
    }

    public function test_environment_input_is_validated(): void
    {
        $this->signIn();
        $url = route('settings.auth.environments.update', 'production');

        $this->putJson($url, $this->environmentPayload(['base_url' => 'http://auth.example.com']))->assertStatus(422)->assertJsonValidationErrors('base_url');
        $this->putJson($url, $this->environmentPayload(['base_url' => 'ftp://auth.example.com']))->assertStatus(422)->assertJsonValidationErrors('base_url');
        $this->putJson($url, $this->environmentPayload(['base_url' => 'https://user:pass@auth.example.com']))->assertStatus(422)->assertJsonValidationErrors('base_url');
        $this->putJson($url, $this->environmentPayload(['base_url' => 'https://169.254.169.254']))->assertStatus(422)->assertJsonValidationErrors('base_url');
        $this->putJson($url, $this->environmentPayload(['base_url' => '']))->assertStatus(422)->assertJsonValidationErrors('base_url');
        $this->putJson($url, $this->environmentPayload(['service_name' => 'has spaces']))->assertStatus(422)->assertJsonValidationErrors('service_name');
        $this->putJson($url, $this->environmentPayload(['service_name' => str_repeat('a', 65)]))->assertStatus(422)->assertJsonValidationErrors('service_name');
        $this->putJson($url, $this->environmentPayload(['nats_url' => 'http://nats']))->assertStatus(422)->assertJsonValidationErrors('nats_url');
        $this->putJson($url, $this->environmentPayload(['api_prefix' => 'no-leading-slash']))->assertStatus(422)->assertJsonValidationErrors('api_prefix');
        $this->putJson(route('settings.auth.environments.update', 'staging'), $this->environmentPayload())->assertNotFound();

        $this->assertSame(PizzasysMock::BASE_URL, AuthEnvironment::query()->where('key', 'production')->sole()->base_url);
    }

    public function test_plain_http_is_accepted_for_local_development_hosts_only(): void
    {
        $this->signIn();
        $url = route('settings.auth.environments.update', 'production');

        // Loopback targets are only accepted on a private-network deployment (or APP_ENV=local).
        config(['chat.portal_allow_private_hosts' => true]);
        $testing = route('settings.auth.environments.update', 'testing');
        // The addresses below are not the mock's: they must behave like unreachable hosts, never reach a real server
        // (a developer's local pizzasys on :8200 would otherwise answer and change the outcome). The testing
        // environment is not the active one, so saving it does not try the portal.
        Http::fake(['*' => fn () => throw new ConnectionException('Stray request blocked in tests.')]);

        foreach (['http://localhost:8200', 'http://127.0.0.1:8200', 'http://portal.test', 'https://auth.example.com/'] as $address) {
            $this->putJson($testing, $this->environmentPayload(['base_url' => $address, 'service_token' => 'testing-token']))->assertRedirect();
        }

        $this->assertSame('https://auth.example.com', AuthEnvironment::query()->where('key', 'testing')->sole()->base_url, 'a trailing slash is dropped');
        $this->assertSame(PizzasysMock::BASE_URL, AuthEnvironment::query()->where('key', 'production')->sole()->base_url);
    }

    public function test_changing_the_active_environment_restarts_nats_and_drops_the_verify_caches(): void
    {
        $this->signIn();
        Cache::put('auth.nats.restart', 2);
        $verifies = $this->portal->calls('token-verify');

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload(['nats_url' => 'nats://nats.example.test:4222']))->assertRedirect();

        $this->assertSame(3, Cache::get('auth.nats.restart'));
        $this->assertTrue(settings('auth.pizzasys.nats.enabled'), 'a NATS URL on the active environment switches the consumer on');
        $this->get(route('dashboard'))->assertOk();
        $this->assertSame($verifies + 1, $this->portal->calls('token-verify'), 'the cached verify answer was dropped');
    }

    public function test_fixing_the_service_token_takes_effect_immediately(): void
    {
        $this->signIn();
        $this->portal->rejectServiceCredential('Service token expired.');
        $this->travel(2)->minutes();
        $this->get(route('dashboard'))->assertOk(); // the rejection is observed (and remembered for a minute)
        $this->assertTrue(app(PortalHealth::class)->serviceRejection('production') !== null);

        $this->portal->acceptServiceCredential();
        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload(['service_token' => PizzasysMock::SERVICE_TOKEN]))->assertRedirect();

        $this->assertNull(app(PortalHealth::class)->serviceRejection('production'));
        $this->get(route('settings.auth.edit'))->assertInertia(fn (Assert $page) => $page->where('authSettings.health.service_credential_rejected', false));
    }

    public function test_an_unchanged_save_changes_nothing_and_writes_no_audit_row(): void
    {
        $this->signIn();
        Cache::put('auth.nats.restart', 2);

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload())->assertRedirect();

        $this->assertSame(2, Cache::get('auth.nats.restart'));
        $this->assertDatabaseMissing('audit_logs', ['action' => 'auth.environment_updated']);
    }

    public function test_updates_are_audited_without_secrets(): void
    {
        $this->signIn();
        $this->portal->acceptServiceToken('audit-me-not-token');

        $this->put(route('settings.auth.environments.update', 'production'), $this->environmentPayload([
            'service_name' => PizzasysMock::SERVICE_NAME,
            'label' => 'Audited',
            'service_token' => 'audit-me-not-token',
            'nats_url' => 'nats://nats.example.test:4222',
            'nats_token' => 'audit-me-not-nats',
        ]))->assertRedirect();

        $row = AuditLog::query()->where('action', 'auth.environment_updated')->sole();
        $this->assertSame(['old' => 'Production', 'new' => 'Audited'], $row->changes['label']);
        $this->assertTrue($row->changes['service_credential_changed']);
        $this->assertSame('dashboard', $row->changes['via']);
        $dump = (string) json_encode($row->changes);
        $this->assertStringNotContainsString('audit-me-not', $dump);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $dump);
    }

    // ---- connection test ----------------------------------------------------------------------------------------

    public function test_the_connection_test_returns_the_checks_and_persists_the_result(): void
    {
        $this->signIn();

        $response = $this->postJson(route('settings.auth.environments.test', 'production'))->assertOk();

        $response->assertJsonPath('ok', true)
            ->assertJsonPath('checks.0.key', 'reachable')
            ->assertJsonPath('checks.1.key', 'service_credential')
            ->assertJsonPath('checks.2.key', 'latency')
            ->assertJsonPath('checks.3.key', 'nats')
            ->assertJsonPath('checks.3.ok', true);
        $this->assertSame(['ok', 'checks'], array_keys($response->json()));
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $response->getContent());

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('ok', $environment->last_check_status);
        $this->assertNotNull($environment->last_check_at);
    }

    public function test_a_failing_test_is_reported_and_remembered(): void
    {
        $this->signIn();
        $this->portal->rejectServiceCredential('Service token expired.');

        $response = $this->postJson(route('settings.auth.environments.test', 'production'))->assertOk();

        $response->assertJsonPath('ok', false)
            ->assertJsonPath('checks.0.ok', true)
            ->assertJsonPath('checks.1.ok', false);
        $this->assertSame('The service token has expired.', $response->json('checks.1.message'));

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('failed', $environment->last_check_status);
        $this->assertSame('The service token has expired.', $environment->last_check_message);
    }

    public function test_testing_an_unconfigured_environment_is_404(): void
    {
        $this->signIn();

        $this->postJson(route('settings.auth.environments.test', 'testing'))->assertNotFound();
    }

    // ---- roles --------------------------------------------------------------------------------------------------

    public function test_the_role_mapping_is_saved_audited_and_every_identity_is_marked_stale(): void
    {
        $this->signIn();
        $this->assertSame(0, UserExternalIdentity::query()->whereNotNull('stale_at')->count());

        $this->put(route('settings.auth.roles.update'), [
            'admin_permission' => 'chat.admin',
            'agent_permission' => 'support.agent',
            'super_roles' => ['super-admin', 'root'],
        ])->assertRedirect();

        $this->assertSame('support.agent', settings('auth.pizzasys.agent_permission'));
        $this->assertSame(['super-admin', 'root'], settings('auth.pizzasys.super_roles'));
        $this->assertSame(1, UserExternalIdentity::query()->whereNotNull('stale_at')->count());

        $row = AuditLog::query()->where('action', 'auth.roles_updated')->sole();
        $this->assertSame('chat.agent', $row->changes['old']['agent_permission']);
        $this->assertSame('support.agent', $row->changes['new']['agent_permission']);
    }

    public function test_new_role_names_take_effect_on_the_next_request_of_everybody(): void
    {
        $this->signIn();
        $this->put(route('settings.auth.roles.update'), ['admin_permission' => 'chat.admin', 'agent_permission' => 'support.agent', 'super_roles' => ['super-admin']])->assertRedirect();
        $this->travel(1)->second();

        $this->get(route('dashboard'))->assertOk();

        $admin = User::query()->where('email', 'admin@test.local')->sole();
        $this->assertTrue($admin->is_admin, 'still an admin through the super role');
    }

    public function test_a_mapping_that_would_lock_the_saving_admin_out_is_refused(): void
    {
        $this->signIn();

        $this->putJson(route('settings.auth.roles.update'), ['admin_permission' => 'typo.admin', 'agent_permission' => 'chat.agent', 'super_roles' => []])
            ->assertStatus(422)
            ->assertJsonValidationErrors('admin_permission');

        $this->assertSame('chat.admin', settings('auth.pizzasys.admin_permission'));
        $this->assertSame(['super-admin'], settings('auth.pizzasys.super_roles'));
    }

    public function test_the_lock_out_check_uses_the_identity_of_the_signed_in_session_not_a_stale_one(): void
    {
        // A deactivated identity of the same person (created first, so an unordered lookup would find it) used to be an admin.
        $person = User::factory()->create(['email' => 'chatadmin@test.local', 'auth_source' => 'pizzasys', 'password' => null]);
        UserExternalIdentity::factory()->granting(['super-admin'], [])->deactivated()->create([
            'user_id' => $person->id,
            'auth_environment_id' => AuthEnvironment::query()->where('key', 'production')->value('id'),
            'external_id' => '5',
        ]);
        $this->signIn('chatadmin@test.local');

        $this->putJson(route('settings.auth.roles.update'), ['admin_permission' => 'typo.admin', 'agent_permission' => 'chat.agent', 'super_roles' => ['super-admin']])
            ->assertStatus(422)
            ->assertJsonValidationErrors('admin_permission');
    }

    public function test_a_chat_admin_may_drop_the_super_roles_as_long_as_the_permission_still_makes_them_admin(): void
    {
        $this->signIn('chatadmin@test.local');

        $this->putJson(route('settings.auth.roles.update'), ['admin_permission' => 'chat.admin', 'agent_permission' => 'chat.agent', 'super_roles' => []])->assertRedirect();

        $this->assertSame([], settings('auth.pizzasys.super_roles'));
    }

    public function test_role_input_is_validated(): void
    {
        $this->signIn();
        $url = route('settings.auth.roles.update');

        $this->putJson($url, ['admin_permission' => '', 'agent_permission' => 'a', 'super_roles' => []])->assertStatus(422)->assertJsonValidationErrors('admin_permission');
        $this->putJson($url, ['admin_permission' => 'a', 'agent_permission' => str_repeat('x', 129), 'super_roles' => []])->assertStatus(422)->assertJsonValidationErrors('agent_permission');
        $this->putJson($url, ['admin_permission' => 'chat.admin', 'agent_permission' => 'a'])->assertStatus(422)->assertJsonValidationErrors('super_roles');
        $this->putJson($url, ['admin_permission' => 'chat.admin', 'agent_permission' => 'a', 'super_roles' => [['x']]])->assertStatus(422)->assertJsonValidationErrors('super_roles.0');
    }
}
