<?php

namespace Tests\Feature\Settings;

use App\Auth\Pizzasys\NatsProbe;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\FakeNatsProbe;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Editing an auth environment must not be a way to steal its secrets or to lock everybody out:
 *  - a stored token is never reused for a new destination (the token has to be typed again);
 *  - an edit of the ACTIVE environment is tried against the portal first and refused when it does not work;
 *  - an administrator can still reach Settings > Auth while the portal is down, to fix it.
 */
class AuthEnvironmentSafetyTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private const NEW_URL = 'https://auth-new.example.test';

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->usePortalMode(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'stored-nats-token']);
        $this->portal = PizzasysMock::make()
            ->user('admin@test.local', 'pw', 'admin', 'Prod Admin')
            ->user('agent@test.local', 'pw', 'agent', 'Prod Agent')
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
    private function payload(array $overrides = []): array
    {
        return [
            'label' => 'Production',
            'base_url' => PizzasysMock::BASE_URL,
            'service_name' => PizzasysMock::SERVICE_NAME,
            'nats_url' => 'nats://nats.example.test:4222',
            'verify_tls' => true,
            ...$overrides,
        ];
    }

    private function url(string $key = 'production'): string
    {
        return route('settings.auth.environments.update', $key);
    }

    private function stored(): AuthEnvironment
    {
        return AuthEnvironment::query()->where('key', 'production')->sole();
    }

    private function assertNothingSentTo(string $host): void
    {
        Http::assertNotSent(fn (Request $request): bool => str_contains($request->url(), $host));
    }

    // ---- finding 2: stored secrets never follow a new destination ----------------------------------------------

    public function test_the_stored_service_token_is_not_sent_to_a_new_portal_address(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['base_url' => 'https://evil.example.test']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['service_token'])
            ->assertJsonPath('errors.service_token.0', 'Re-enter the service token to change the portal address.');

        $this->assertNothingSentTo('evil.example.test');
        $this->assertSame(PizzasysMock::BASE_URL, $this->stored()->base_url);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token);
    }

    public function test_the_same_holds_for_a_form_post(): void
    {
        $this->signIn();

        $this->from(route('settings.auth.edit'))
            ->put($this->url(), $this->payload(['base_url' => 'https://evil.example.test']))
            ->assertRedirect(route('settings.auth.edit'))
            ->assertSessionHasErrors(['service_token']);

        $this->assertNothingSentTo('evil.example.test');
    }

    public function test_changing_the_service_name_needs_the_token_again_too(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['service_name' => 'someone-else']))
            ->assertStatus(422)
            ->assertJsonPath('errors.service_token.0', 'Re-enter the service token to change the service name.');

        $this->assertSame(PizzasysMock::SERVICE_NAME, $this->stored()->service_name);
    }

    public function test_turning_certificate_verification_off_needs_the_tokens_again(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['verify_tls' => false]))
            ->assertStatus(422)
            ->assertJsonPath('errors.service_token.0', 'Re-enter the service token to turn off certificate verification.')
            ->assertJsonPath('errors.nats_token.0', 'Re-enter the NATS token to turn off certificate verification.');

        $this->assertTrue($this->stored()->verify_tls);
    }

    public function test_turning_certificate_verification_on_needs_nothing(): void
    {
        $this->signIn();
        $this->stored()->forceFill(['verify_tls' => false])->save();

        $this->putJson($this->url(), $this->payload(['verify_tls' => true]))->assertRedirect();

        $this->assertTrue($this->stored()->verify_tls);
    }

    public function test_a_new_nats_address_needs_the_nats_token_again(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['nats_url' => 'nats://evil.example.test:4222']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['nats_token'])
            ->assertJsonPath('errors.nats_token.0', 'Re-enter the NATS token to change the NATS address.');

        $this->assertSame('nats://nats.example.test:4222', $this->stored()->nats_url);
        $this->assertSame('stored-nats-token', $this->stored()->nats_token);
        $probe = app(NatsProbe::class);
        $this->assertInstanceOf(FakeNatsProbe::class, $probe);
        $this->assertCount(0, $probe->probed, 'the stored NATS token was not offered to the new server');
    }

    public function test_a_new_nats_address_is_accepted_with_a_typed_or_an_explicitly_cleared_token(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['nats_url' => 'nats://nats-two.example.test:4222', 'nats_token' => 'typed-nats-token']))->assertRedirect();
        $this->assertSame('typed-nats-token', $this->stored()->nats_token);

        $this->putJson($this->url(), $this->payload(['nats_url' => 'nats://nats-three.example.test:4222', 'nats_token' => null]))->assertRedirect();
        $this->assertNull($this->stored()->nats_token, 'cleared: nothing is sent to the new server');
        $this->assertSame('nats://nats-three.example.test:4222', $this->stored()->nats_url);
    }

    public function test_leaving_the_nats_address_alone_keeps_its_token(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['label' => 'Renamed']))->assertRedirect();

        $this->assertSame('stored-nats-token', $this->stored()->nats_token);
    }

    public function test_adding_a_nats_address_where_none_had_a_token_needs_nothing(): void
    {
        $this->signIn();
        $this->stored()->forceFill(['nats_url' => null, 'nats_token' => null])->save();

        $this->putJson($this->url(), $this->payload(['nats_url' => 'nats://nats-new.example.test:4222']))->assertRedirect();

        $this->assertSame('nats://nats-new.example.test:4222', $this->stored()->nats_url);
    }

    public function test_the_address_comparison_ignores_case_and_a_trailing_slash(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['base_url' => strtoupper(PizzasysMock::BASE_URL).'/']))->assertRedirect();
    }

    public function test_an_address_change_with_the_token_typed_again_goes_to_the_new_portal_with_the_new_token_only(): void
    {
        $this->signIn();
        $second = PizzasysMock::make(self::NEW_URL)->acceptServiceToken('new-portal-service-token')->fake();

        $this->putJson($this->url(), $this->payload(['base_url' => self::NEW_URL, 'service_token' => 'new-portal-service-token']))->assertRedirect();

        $this->assertSame(self::NEW_URL, $this->stored()->base_url);
        $this->assertSame('new-portal-service-token', $this->stored()->service_token);
        $this->assertGreaterThan(0, $second->calls('token-verify'), 'the pre-flight test reached the new portal');

        $oldToken = PizzasysMock::SERVICE_TOKEN;
        Http::assertNotSent(fn (Request $request): bool => str_contains($request->url(), 'auth-new.example.test')
            && ($request->header('Authorization')[0] ?? '') !== 'Bearer new-portal-service-token');
        Http::assertNotSent(fn (Request $request): bool => str_contains($request->url(), 'auth-new.example.test')
            && str_contains((string) json_encode($request->data()), $oldToken));
    }

    public function test_address_changes_are_flagged_in_the_audit_log_and_never_carry_a_secret(): void
    {
        $this->signIn();
        PizzasysMock::make(self::NEW_URL)->acceptServiceToken('new-portal-service-token')->fake();

        $this->putJson($this->url(), $this->payload(['base_url' => self::NEW_URL, 'service_token' => 'new-portal-service-token']))->assertRedirect();

        $row = AuditLog::query()->where('action', 'auth.environment_updated')->sole();
        $this->assertTrue($row->changes['address_changed']);
        $this->assertSame(['old' => PizzasysMock::BASE_URL, 'new' => self::NEW_URL], $row->changes['base_url']);
        $this->assertStringNotContainsString('new-portal-service-token', (string) json_encode($row->changes));
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, (string) json_encode($row->changes));
    }

    public function test_a_label_change_is_not_flagged_as_an_address_change(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['label' => 'Renamed']))->assertRedirect();

        $this->assertArrayNotHasKey('address_changed', AuditLog::query()->where('action', 'auth.environment_updated')->sole()->changes);
    }

    public function test_a_brand_new_environment_needs_its_token_but_nothing_else(): void
    {
        $this->signIn();
        $url = $this->url('testing');
        $payload = $this->payload(['label' => 'Testing', 'base_url' => 'https://auth-testing.example.test', 'nats_url' => null]);

        $this->putJson($url, $payload)->assertStatus(422)->assertJsonValidationErrors('service_token');
        $this->putJson($url, [...$payload, 'service_token' => 'testing-token'])->assertRedirect();
    }

    public function test_two_requests_creating_the_same_environment_at_once_do_not_crash(): void
    {
        $this->signIn();
        $failed = false;
        AuthEnvironment::creating(function () use (&$failed): void {
            if (! $failed) {
                $failed = true;
                throw new UniqueConstraintViolationException('sqlite', 'insert into "auth_environments"', [], new \Exception('UNIQUE constraint failed'));
            }
        });

        $this->putJson($this->url('testing'), $this->payload(['label' => 'Testing', 'base_url' => 'https://auth-testing.example.test', 'nats_url' => null, 'service_token' => 'testing-token']))
            ->assertRedirect();

        $this->assertTrue($failed);
        $this->assertSame(1, AuthEnvironment::query()->where('key', 'testing')->count());
    }

    // ---- finding 3: a bad edit of the active environment is refused, not saved -----------------------------------

    public function test_an_unreachable_address_for_the_active_environment_is_refused_and_nothing_is_saved(): void
    {
        $this->signIn();
        Http::fake([self::NEW_URL.'/*' => fn () => throw new ConnectionException('cURL error 7: Failed to connect')]);
        $stored = $this->stored()->only(['base_url', 'service_token_encrypted']);

        $response = $this->putJson($this->url(), $this->payload(['base_url' => self::NEW_URL, 'service_token' => 'typed-token']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['connection', 'base_url'])
            ->assertJsonPath('checks.0.key', 'reachable')
            ->assertJsonPath('checks.0.ok', false);

        $this->assertStringNotContainsString('typed-token', $response->getContent());
        $this->assertSame($stored, $this->stored()->only(['base_url', 'service_token_encrypted']));
        $this->assertDatabaseMissing('audit_logs', ['action' => 'auth.environment_updated']);
    }

    public function test_a_service_token_the_portal_refuses_is_not_saved_for_the_active_environment(): void
    {
        $this->signIn();

        $this->putJson($this->url(), $this->payload(['service_token' => 'a-typo']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['connection', 'service_token'])
            ->assertJsonPath('checks.1.key', 'service_credential')
            ->assertJsonPath('checks.1.ok', false);

        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token);
    }

    public function test_a_failing_pre_flight_of_a_form_post_comes_back_as_field_errors(): void
    {
        $this->signIn();

        $this->from(route('settings.auth.edit'))
            ->put($this->url(), $this->payload(['service_token' => 'a-typo']))
            ->assertRedirect(route('settings.auth.edit'))
            ->assertSessionHasErrors(['connection', 'service_token']);

        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token);
    }

    public function test_an_edit_that_works_is_saved(): void
    {
        $this->signIn();
        $this->portal->acceptServiceToken('rotated-token');

        $this->putJson($this->url(), $this->payload(['service_token' => 'rotated-token']))->assertRedirect();

        $this->assertSame('rotated-token', $this->stored()->service_token);
    }

    public function test_only_the_active_environment_is_tried_first(): void
    {
        $this->signIn();
        $this->useTestingEnvironment();
        Http::fake(['https://auth-testing-two.example.test/*' => fn () => throw new \RuntimeException('The pre-flight must not run for an inactive environment.')]);

        $this->putJson($this->url('testing'), $this->payload(['label' => 'Testing', 'base_url' => 'https://auth-testing-two.example.test', 'service_token' => 'whatever', 'nats_url' => null]))
            ->assertRedirect();

        $this->assertSame('https://auth-testing-two.example.test', AuthEnvironment::query()->where('key', 'testing')->sole()->base_url);
    }

    public function test_edits_that_do_not_change_how_the_portal_is_called_skip_the_pre_flight(): void
    {
        $this->signIn();
        $verifies = $this->portal->calls('token-verify');

        $this->putJson($this->url(), $this->payload(['label' => 'Renamed', 'nats_url' => 'nats://other.example.test:4222', 'nats_token' => 'other-nats-token']))->assertRedirect();

        $this->assertSame($verifies, $this->portal->calls('token-verify'));
    }

    public function test_the_break_glass_path_does_not_try_the_portal_first(): void
    {
        $this->signIn();
        $this->portal->outage('connection');

        $this->artisan('chat:auth:set-env', ['env' => 'production', '--base-url' => 'https://elsewhere.example.test', '--token-file' => $this->tokenFile('typed-token')])
            ->assertSuccessful();

        $this->assertSame('https://elsewhere.example.test', $this->stored()->base_url);
    }

    // ---- finding 3: the settings stay reachable while the portal is down -----------------------------------------

    public function test_the_auth_settings_stay_reachable_when_every_other_page_answers_503(): void
    {
        $this->signIn();
        $this->portal->outage('connection');
        $this->travel(31)->minutes();

        $this->get(route('dashboard'))->assertStatus(503);
        $this->get(route('settings.auth.edit'))->assertOk();
        $this->postJson(route('settings.auth.environments.test', 'production'))->assertOk()->assertJsonPath('ok', false);
    }

    public function test_the_administrator_can_repair_a_wrong_address_while_the_portal_is_down(): void
    {
        $this->signIn();
        $this->portal->outage('connection');
        $this->travel(31)->minutes();
        $this->get(route('dashboard'))->assertStatus(503);
        PizzasysMock::make(self::NEW_URL)->acceptServiceToken('repaired-token')->fake();

        $this->putJson($this->url(), $this->payload(['base_url' => self::NEW_URL, 'service_token' => 'repaired-token']))->assertRedirect();

        $this->assertSame(self::NEW_URL, $this->stored()->base_url);
    }

    public function test_other_routes_still_answer_503_and_signing_out_still_works(): void
    {
        $this->signIn();
        $this->portal->outage('connection');
        $this->travel(31)->minutes();

        $this->get(route('dashboard'))->assertStatus(503);
        $this->post(route('logout'))->assertRedirect('/');
        $this->assertGuest();
    }

    public function test_the_exemption_does_not_open_the_settings_to_agents(): void
    {
        $this->signIn('agent@test.local');
        $this->portal->outage('connection');
        $this->travel(31)->minutes();

        $this->get(route('settings.auth.edit'))->assertForbidden();
    }

    private function tokenFile(string $token): string
    {
        $path = storage_path('framework/testing/token-'.bin2hex(random_bytes(4)));
        @mkdir(dirname($path), 0775, true);
        file_put_contents($path, $token."\n");
        $this->beforeApplicationDestroyed(fn () => @unlink($path));

        return $path;
    }
}
