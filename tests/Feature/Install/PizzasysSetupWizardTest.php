<?php

namespace Tests\Feature\Install;

use App\Auth\Roles\RoleMapping;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\PizzasysMock;

/**
 * The mode-2 wizard through HTTP: portal environments + roles, connection test, the verified portal administrator,
 * then the run steps against an empty database. Tokens are encrypted in the install state and never come back.
 */
class PizzasysSetupWizardTest extends InstallTestCase
{
    private const TESTING_URL = 'https://auth-testing.example.test';

    private const ADMIN_PASSWORD = 'portal-admin-password-1';

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->portal = PizzasysMock::make()
            ->user('admin@test.local', self::ADMIN_PASSWORD, 'admin', 'Portal Admin')
            ->user('chatadmin@test.local', 'pw', 'chatadmin', 'Chat Admin')
            ->user('agent@test.local', 'pw', 'agent', 'Plain Agent')
            ->user('norole@test.local', 'pw', 'norole', 'Nobody')
            ->fake();
    }

    private function choosePizzasys(): void
    {
        $this->verifySetupToken();
        $this->post(route('setup.mode'), ['mode' => 'pizzasys'])->assertRedirect(route('setup.index'));
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function pizzasysPayload(array $overrides = []): array
    {
        return array_replace_recursive([
            'environments' => [
                'production' => [
                    'base_url' => PizzasysMock::BASE_URL,
                    'service_name' => PizzasysMock::SERVICE_NAME,
                    'service_token' => PizzasysMock::SERVICE_TOKEN,
                    'nats_url' => null,
                    'nats_token' => null,
                    'verify_tls' => true,
                ],
            ],
            'active_env' => 'production',
            'admin_permission' => 'chat.admin',
            'agent_permission' => 'chat.agent',
            'super_roles' => ['super-admin'],
        ], $overrides);
    }

    private function postPizzasys(array $overrides = []): void
    {
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload($overrides))->assertRedirect(route('setup.index'));
    }

    private function postPortalAdmin(string $email = 'admin@test.local', string $password = self::ADMIN_PASSWORD)
    {
        return $this->postJson(route('setup.portal-admin'), ['email' => $email, 'password' => $password]);
    }

    private function runSteps(): void
    {
        foreach (['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'] as $step) {
            $this->postJson(route('setup.run', $step))->assertOk()->assertJsonPath('status', 'ok');
        }
    }

    // ---- screens + props ----------------------------------------------------------------------------------------

    public function test_choosing_pizzasys_leads_to_the_portal_screen_then_the_portal_admin_screen(): void
    {
        $this->choosePizzasys();

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'pizzasys')
            ->where('setup.mode', 'pizzasys')
            ->where('setup.pizzasysAvailable', true)
            ->where('setup.steps.0.key', 'welcome')
            ->where('setup.steps.1.key', 'mode')
            ->where('setup.steps.2.key', 'pizzasys')
            ->where('setup.steps.3.key', 'portal-admin')
            ->where('setup.steps.4.key', 'basics')
            ->where('setup.steps.5.key', 'run')
            ->where('setup.steps.6.key', 'done')
            ->has('setup.steps', 7)
            ->where('setup.steps.2.status', 'current')
            ->where('setup.pizzasys.active_env', 'production')
            ->where('setup.pizzasys.environments.production.configured', false)
            ->where('setup.pizzasys.environments.production.key', 'production')
            ->where('setup.pizzasys.environments.testing.configured', false)
            ->where('setup.pizzasys.roles', ['admin_permission' => 'chat.admin', 'agent_permission' => 'chat.agent', 'super_roles' => ['super-admin']])
            ->where('setup.pizzasys.tested', ['production' => false, 'testing' => false])
            ->where('setup.pizzasys.portal_admin', null));

        $this->postPizzasys();
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'portal-admin')->where('setup.steps.2.status', 'done'));

        $this->postPortalAdmin()->assertOk();
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'basics')->where('setup.steps.3.status', 'done'));

        $this->postBasics();
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'run'));
    }

    public function test_the_fortify_wizard_never_shows_the_portal_screens(): void
    {
        $this->verifySetupToken();
        $this->chooseFortify();

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'admin')
            ->where('setup.pizzasys', null)
            ->has('setup.steps', 6));
    }

    public function test_the_saved_answers_come_back_without_any_token(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token'], 'testing' => [
            'base_url' => self::TESTING_URL, 'service_name' => 'pne-chat-testing', 'service_token' => 'testing-wizard-token', 'verify_tls' => false,
        ]], 'active_env' => 'testing', 'super_roles' => ['super-admin', 'root'], 'agent_permission' => 'support.agent']);

        $response = $this->getJson(route('setup.state'))->assertOk();

        $response->assertJsonPath('setup.pizzasys.active_env', 'testing')
            ->assertJsonPath('setup.pizzasys.environments.production.configured', true)
            ->assertJsonPath('setup.pizzasys.environments.production.base_url', PizzasysMock::BASE_URL)
            ->assertJsonPath('setup.pizzasys.environments.production.has_service_token', true)
            ->assertJsonPath('setup.pizzasys.environments.production.nats_url', 'nats://nats.example.test:4222')
            ->assertJsonPath('setup.pizzasys.environments.production.has_nats_token', true)
            ->assertJsonPath('setup.pizzasys.environments.testing.configured', true)
            ->assertJsonPath('setup.pizzasys.environments.testing.service_name', 'pne-chat-testing')
            ->assertJsonPath('setup.pizzasys.environments.testing.verify_tls', false)
            ->assertJsonPath('setup.pizzasys.roles.agent_permission', 'support.agent')
            ->assertJsonPath('setup.pizzasys.roles.super_roles', ['super-admin', 'root']);

        $body = $response->getContent();
        foreach ([PizzasysMock::SERVICE_TOKEN, 'nats-wizard-token', 'testing-wizard-token', '"service_token"', '"nats_token"'] as $secret) {
            $this->assertStringNotContainsString($secret, $body);
        }
    }

    // ---- storage ------------------------------------------------------------------------------------------------

    public function test_tokens_are_stored_encrypted_in_the_install_state_only(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);

        $file = (string) file_get_contents($this->install->statePath());
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $file);
        $this->assertStringNotContainsString('nats-wizard-token', $file);

        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, Crypt::decryptString($stored['service_token']));
        $this->assertSame('nats-wizard-token', Crypt::decryptString($stored['nats_token']));
        $this->assertSame('0600', substr(sprintf('%o', fileperms($this->install->statePath())), -4));
    }

    public function test_a_second_post_without_tokens_keeps_the_stored_ones(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => null, 'nats_url' => 'nats://nats.example.test:4222', 'nats_token' => null, 'api_prefix' => '/api/v1']]]))
            ->assertRedirect(route('setup.index'));

        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, Crypt::decryptString($stored['service_token']));
        $this->assertSame('nats-wizard-token', Crypt::decryptString($stored['nats_token']));
    }

    // ---- a stored token never follows a new destination ---------------------------------------------------------

    public function test_a_new_portal_address_needs_the_service_token_again(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);
        $before = $this->install->read()['auth_environments']['environments']['production'];

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['base_url' => 'https://evil.example.test', 'service_token' => null, 'nats_url' => 'nats://nats.example.test:4222']]]))
            ->assertSessionHasErrors(['environments.production.service_token' => 'Re-enter the service token to change the portal address.']);

        $this->assertSame($before, $this->install->read()['auth_environments']['environments']['production'], 'nothing changed');
        Http::assertNotSent(fn ($request): bool => str_contains($request->url(), 'evil.example.test'));
    }

    public function test_a_new_service_name_or_switching_verification_off_needs_the_service_token_again(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_name' => 'renamed', 'service_token' => null]]]))
            ->assertSessionHasErrors(['environments.production.service_token' => 'Re-enter the service token to change the service name.']);
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['verify_tls' => false, 'service_token' => null]]]))
            ->assertSessionHasErrors(['environments.production.service_token' => 'Re-enter the service token to turn off certificate verification.']);
    }

    public function test_a_new_nats_address_needs_the_nats_token_again(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => null, 'nats_url' => 'nats://nats-two.example.test:4222', 'nats_token' => null]]]))
            ->assertSessionHasErrors(['environments.production.nats_token' => 'Re-enter the NATS token to change the NATS address.']);

        // typed again, or explicitly dropped, is fine
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => null, 'nats_url' => 'nats://nats-two.example.test:4222', 'nats_token' => 'second-nats-token']]]))
            ->assertRedirect(route('setup.index'));
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => null, 'nats_url' => 'nats://nats-three.example.test:4222', 'nats_token' => null, 'clear_nats_token' => true]]]))
            ->assertRedirect(route('setup.index'));

        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertSame('nats://nats-three.example.test:4222', $stored['nats_url']);
        $this->assertNull($stored['nats_token']);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, Crypt::decryptString($stored['service_token']));
    }

    public function test_a_new_destination_with_its_token_typed_again_is_stored_with_the_new_token_only(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['base_url' => 'https://auth-two.example.test', 'service_token' => 'second-service-token']]]))
            ->assertRedirect(route('setup.index'));

        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertSame('https://auth-two.example.test', $stored['base_url']);
        $this->assertSame('second-service-token', Crypt::decryptString($stored['service_token']));
    }

    public function test_even_a_caller_that_skips_the_validation_cannot_carry_a_token_to_a_new_destination(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);

        app(StoreInstallAnswers::class)->pizzasys(
            ['production' => [
                'base_url' => 'https://evil.example.test', 'service_name' => PizzasysMock::SERVICE_NAME, 'service_token' => null,
                'nats_url' => 'nats://evil.example.test:4222', 'nats_token' => null, 'verify_tls' => true,
            ]],
            'production',
            new RoleMapping,
        );

        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertNull($stored['service_token']);
        $this->assertNull($stored['nats_token']);
    }

    public function test_an_empty_token_field_means_keep_and_a_cleared_nats_url_drops_the_nats_token(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token']]]);

        // the form posts '' for fields the user left alone
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => '', 'nats_url' => 'nats://nats.example.test:4222', 'nats_token' => '']]]))
            ->assertRedirect(route('setup.index'));
        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, Crypt::decryptString($stored['service_token']));
        $this->assertSame('nats-wizard-token', Crypt::decryptString($stored['nats_token']));

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['service_token' => '', 'nats_url' => null, 'nats_token' => null]]]))
            ->assertRedirect(route('setup.index'));
        $stored = $this->install->read()['auth_environments']['environments']['production'];
        $this->assertNull($stored['nats_url']);
        $this->assertNull($stored['nats_token']);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, Crypt::decryptString($stored['service_token']), 'the service token is never wiped');
    }

    public function test_errors_come_back_under_dotted_keys_and_the_step_advances_only_on_success(): void
    {
        $this->choosePizzasys();

        $this->post(route('setup.pizzasys'), $this->pizzasysPayload([
            'environments' => ['production' => ['base_url' => 'ftp://x'], 'testing' => ['base_url' => self::TESTING_URL]],
            'active_env' => 'staging',
            'super_roles' => [str_repeat('x', 65)],
        ]))->assertSessionHasErrors([
            'environments.production.base_url',
            'environments.testing.service_name',
            'environments.testing.service_token',
            'active_env',
            'super_roles.0',
        ]);
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'pizzasys'));

        $this->postPizzasys();
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'portal-admin'));
    }

    public function test_connection_test_messages_are_plain_curated_text_without_upstream_content(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        Http::swap(new Factory);
        Http::fake([PizzasysMock::BASE_URL.'/*' => Http::response(['message' => 'Invalid service token. <b>'.PizzasysMock::SERVICE_TOKEN.'</b>'], 401)]);

        $response = $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertOk();

        $this->assertSame('The portal rejected the service credential.', $response->json('checks.1.message'));
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $response->getContent());
        $this->assertStringNotContainsString('<b>', $response->getContent());
    }

    public function test_changing_the_portal_answers_forgets_what_was_proven_against_the_old_ones(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertOk();
        $this->postPortalAdmin()->assertOk();
        $this->assertTrue($this->install->read()['auth_environments']['environments']['production']['tested']);
        $this->assertNotNull($this->install->read()['auth_environments']['portal_admin']);
        $this->install->markRun('seed-defaults', 'done');
        $this->install->markRun('create-admin', 'done');

        $this->postPizzasys(['environments' => ['production' => ['service_name' => 'another-service']]]);

        $state = $this->install->read();
        $this->assertFalse($state['auth_environments']['environments']['production']['tested']);
        $this->assertNull($state['auth_environments']['portal_admin']);
        $this->assertArrayNotHasKey('seed-defaults', $state['run']);
        $this->assertArrayNotHasKey('create-admin', $state['run']);
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'portal-admin'));
    }

    public function test_removing_the_testing_environment_by_leaving_it_empty(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['testing' => ['base_url' => self::TESTING_URL, 'service_name' => 'x', 'service_token' => 'testing-token']]]);
        $this->assertArrayHasKey('testing', $this->install->read()['auth_environments']['environments']);

        $this->postPizzasys();

        $this->assertArrayNotHasKey('testing', $this->install->read()['auth_environments']['environments']);
    }

    // ---- validation + guards ------------------------------------------------------------------------------------

    public function test_the_portal_form_is_validated(): void
    {
        $this->choosePizzasys();
        $post = fn (array $overrides) => $this->post(route('setup.pizzasys'), $this->pizzasysPayload($overrides));

        $post(['environments' => ['production' => ['base_url' => 'http://auth.example.com']]])->assertSessionHasErrors('environments.production.base_url');
        $post(['environments' => ['production' => ['base_url' => 'not a url']]])->assertSessionHasErrors('environments.production.base_url');
        $post(['environments' => ['production' => ['base_url' => 'https://u:p@auth.example.com']]])->assertSessionHasErrors('environments.production.base_url');
        $post(['environments' => ['production' => ['base_url' => 'https://169.254.169.254']]])->assertSessionHasErrors('environments.production.base_url');
        $post(['environments' => ['production' => ['service_name' => 'bad name!']]])->assertSessionHasErrors('environments.production.service_name');
        $post(['environments' => ['production' => ['service_token' => '']]])->assertSessionHasErrors('environments.production.service_token');
        $post(['environments' => ['production' => ['nats_url' => 'redis://x']]])->assertSessionHasErrors('environments.production.nats_url');
        $post(['active_env' => 'staging'])->assertSessionHasErrors('active_env');
        $post(['active_env' => 'testing'])->assertSessionHasErrors('active_env');
        $post(['environments' => ['testing' => ['base_url' => self::TESTING_URL]]])->assertSessionHasErrors(['environments.testing.service_name', 'environments.testing.service_token']);
        $post(['admin_permission' => ''])->assertSessionHasErrors('admin_permission');

        $this->assertSame([], $this->install->read()['auth_environments']);
    }

    public function test_plain_http_is_fine_for_local_hosts(): void
    {
        // Loopback targets are only accepted on a private-network deployment (or APP_ENV=local).
        config(['chat.portal_allow_private_hosts' => true]);
        $this->choosePizzasys();

        foreach (['http://localhost:8200', 'http://127.0.0.1:8200', 'http://portal.test'] as $url) {
            $this->post(route('setup.pizzasys'), $this->pizzasysPayload(['environments' => ['production' => ['base_url' => $url]]]))->assertSessionHasNoErrors();
        }
    }

    public function test_the_portal_endpoints_need_the_setup_token_and_the_pizzasys_mode(): void
    {
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertForbidden();
        $this->postJson(route('setup.portal-admin'), ['email' => 'a@b.test', 'password' => 'x'])->assertForbidden();
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload())->assertRedirect(route('setup.index'));
        $this->assertSame([], $this->install->read()['auth_environments']);

        $this->verifySetupToken();
        $this->chooseFortify();
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload())->assertForbidden();
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertForbidden();
        $this->postJson(route('setup.portal-admin'), ['email' => 'a@b.test', 'password' => 'x'])->assertForbidden();
    }

    public function test_the_portal_endpoints_are_gone_after_the_install(): void
    {
        $this->artisan('migrate', ['--force' => true]);
        $this->install->writeLock();

        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertNotFound();
        $this->postJson(route('setup.portal-admin'), ['email' => 'a@b.test', 'password' => 'x'])->assertNotFound();
        $this->post(route('setup.pizzasys'), $this->pizzasysPayload())->assertNotFound();
    }

    // ---- connection test ----------------------------------------------------------------------------------------

    public function test_the_connection_test_reports_the_checks_and_records_the_result(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $response = $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertOk();

        $response->assertJsonPath('ok', true)
            ->assertJsonPath('checks.0.key', 'reachable')
            ->assertJsonPath('checks.1.key', 'service_credential')
            ->assertJsonPath('checks.2.key', 'latency')
            ->assertJsonPath('checks.3.key', 'nats');
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $response->getContent());
        $this->assertTrue($this->install->read()['auth_environments']['environments']['production']['tested']);
        $this->getJson(route('setup.state'))->assertJsonPath('setup.pizzasys.tested.production', true);
    }

    public function test_a_failing_test_says_why_and_is_not_marked_as_tested(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->portal->rejectServiceCredential('Invalid service token.');

        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])
            ->assertOk()
            ->assertJsonPath('ok', false)
            ->assertJsonPath('checks.0.ok', true)
            ->assertJsonPath('checks.1.ok', false);

        $this->assertFalse($this->install->read()['auth_environments']['environments']['production']['tested']);
    }

    public function test_an_unreachable_portal_fails_the_test_without_leaking_details(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->portal->outage('connection');

        $response = $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertOk();

        $response->assertJsonPath('ok', false)->assertJsonPath('checks.0.ok', false);
        $this->assertStringNotContainsString('auth.example.test port', $response->getContent());
    }

    public function test_the_test_needs_a_saved_environment(): void
    {
        $this->choosePizzasys();

        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production'])->assertStatus(422)->assertJsonValidationErrors('env');
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'nope'])->assertStatus(422)->assertJsonValidationErrors('env');

        $this->postPizzasys();
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'testing'])->assertStatus(422)->assertJsonValidationErrors('env');
        $this->portal->assertNoCalls();
    }

    // ---- portal administrator -----------------------------------------------------------------------------------

    public function test_a_portal_administrator_is_verified_and_the_token_is_discarded(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->postPortalAdmin()
            ->assertOk()
            ->assertExactJson(['ok' => true, 'user' => ['name' => 'Portal Admin', 'email' => 'admin@test.local'], 'isAdmin' => true]);

        $this->assertSame(1, $this->portal->calls('login'));
        $this->assertSame(1, $this->portal->calls('token-verify'));
        $this->assertSame(1, $this->portal->calls('logout'), 'upstream tokens never expire, so the check token is closed');
        $this->assertNotNull($this->install->read()['auth_environments']['portal_admin']);

        $file = (string) file_get_contents($this->install->statePath());
        $this->assertStringNotContainsString(self::ADMIN_PASSWORD, $file);
        $this->assertStringNotContainsString($this->portal->tokenFor('admin@test.local'), $file);
        $this->getJson(route('setup.state'))
            ->assertJsonPath('setup.pizzasys.portal_admin', ['name' => 'Portal Admin', 'email' => 'admin@test.local'])
            ->assertJsonPath('setup.pizzasys.tested.production', true);
        $this->assertStringNotContainsString(self::ADMIN_PASSWORD, $this->getJson(route('setup.state'))->getContent());
    }

    public function test_an_admin_by_permission_works_too(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->postPortalAdmin('chatadmin@test.local', 'pw')->assertOk()->assertJsonPath('isAdmin', true);
    }

    public function test_the_wizards_own_role_names_decide_who_is_an_admin(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['admin_permission' => 'portal.owner', 'super_roles' => []]);

        $this->postPortalAdmin('chatadmin@test.local', 'pw')->assertStatus(422)->assertJsonPath('code', 'no_chat_access');

        $this->portal->claims('chatadmin@test.local', [], ['portal.owner']);
        $this->postPortalAdmin('chatadmin@test.local', 'pw')->assertOk();
    }

    public function test_the_failures_each_have_a_code_and_nothing_is_remembered(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->postPortalAdmin('admin@test.local', 'wrong-password')->assertStatus(422)->assertJson(['ok' => false, 'code' => 'invalid'])->assertJsonStructure(['message']);
        $this->postPortalAdmin('agent@test.local', 'pw')->assertStatus(422)->assertJsonPath('code', 'not_admin');
        $this->postPortalAdmin('norole@test.local', 'pw')->assertStatus(422)->assertJsonPath('code', 'no_chat_access');

        $this->portal->outage('timeout');
        $this->postPortalAdmin()->assertStatus(422)->assertJsonPath('code', 'unavailable');
        $this->portal->recover();

        $this->portal->rejectServiceCredential();
        $this->postPortalAdmin()->assertStatus(422)->assertJsonPath('code', 'unavailable')->assertJsonPath('message', 'The portal rejected the service credentials. Check the service name and token.');

        $this->assertNull($this->install->read()['auth_environments']['portal_admin']);
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'portal-admin'));
    }

    public function test_the_portal_admin_needs_saved_portal_settings_first(): void
    {
        $this->choosePizzasys();

        $this->postPortalAdmin()->assertStatus(422)->assertJsonPath('code', 'not_configured');
        $this->portal->assertNoCalls();
    }

    public function test_the_portal_admin_form_is_validated_and_throttled(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();

        $this->postJson(route('setup.portal-admin'), ['email' => 'nope', 'password' => ''])->assertStatus(422)->assertJsonValidationErrors(['email', 'password']);

        for ($i = 0; $i < 4; $i++) {
            $this->postPortalAdmin('admin@test.local', 'wrong')->assertStatus(422);
        }
        $this->postPortalAdmin('admin@test.local', 'wrong')->assertStatus(429);
    }

    // ---- the run ------------------------------------------------------------------------------------------------

    public function test_the_whole_wizard_installs_a_portal_backed_app_with_the_verified_admin(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys([
            'environments' => [
                'production' => ['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-wizard-token'],
                'testing' => ['base_url' => self::TESTING_URL, 'service_name' => 'pne-chat-testing', 'service_token' => 'testing-wizard-token'],
            ],
            'agent_permission' => 'support.agent',
            'super_roles' => ['super-admin', 'root'],
        ]);
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'run')
            ->where('setup.run.0.key', 'run-migrations')
            ->where('setup.run.1.key', 'seed-defaults')
            ->where('setup.run.2.key', 'create-admin')
            ->where('setup.run.3.key', 'write-lock')
            ->has('setup.run', 4));

        $this->postJson(route('setup.run', 'run-migrations'))->assertExactJson(['status' => 'ok', 'next' => 'seed-defaults']);
        $this->postJson(route('setup.run', 'seed-defaults'))->assertExactJson(['status' => 'ok', 'next' => 'create-admin']);
        $this->postJson(route('setup.run', 'create-admin'))->assertExactJson(['status' => 'ok', 'next' => 'write-lock']);
        $this->postJson(route('setup.run', 'write-lock'))->assertExactJson(['status' => 'ok', 'next' => null, 'redirect' => '/login']);

        $this->assertTrue($this->install->isInstalled());

        // environments: encrypted at rest, decryptable by the model
        $production = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame(PizzasysMock::BASE_URL, $production->base_url);
        $this->assertSame(PizzasysMock::SERVICE_NAME, $production->service_name);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $production->service_token);
        $this->assertSame('nats-wizard-token', $production->nats_token);
        $this->assertNotSame(PizzasysMock::SERVICE_TOKEN, $production->service_token_encrypted);
        $this->assertSame('nats://nats.example.test:4222', $production->nats_url);
        $testing = AuthEnvironment::query()->where('key', 'testing')->sole();
        $this->assertSame('testing-wizard-token', $testing->service_token);

        // settings
        $this->assertSame('pizzasys', settings('auth.mode'));
        $this->assertSame('production', settings('auth.pizzasys.active_env'));
        $this->assertSame('chat.admin', settings('auth.pizzasys.admin_permission'));
        $this->assertSame('support.agent', settings('auth.pizzasys.agent_permission'));
        $this->assertSame(['super-admin', 'root'], settings('auth.pizzasys.super_roles'));
        $this->assertTrue(settings('auth.pizzasys.nats.enabled'));
        $this->assertSame(60, settings('auth.pizzasys.verify_ttl_seconds'));
        $this->assertSame(30, settings('auth.pizzasys.grace_minutes'));
        $this->assertSame(3, settings('auth.pizzasys.verify_timeout_seconds'));
        $this->assertTrue(settings('auth.pizzasys.nats.ensure_stream'));
        $this->assertTrue(settings('app.installed'));

        // the first administrator is the verified portal admin
        $admin = User::query()->where('email', 'admin@test.local')->sole();
        $this->assertTrue($admin->is_admin);
        $this->assertTrue($admin->is_agent);
        $this->assertTrue($admin->is_active);
        $this->assertSame('pizzasys', $admin->auth_source);
        $this->assertNull($admin->password);
        $this->assertSame('Portal Admin', $admin->name);
        $identity = UserExternalIdentity::query()->where('user_id', $admin->id)->sole();
        $this->assertSame($this->portal->idFor('admin@test.local'), $identity->external_id);
        $this->assertSame($production->id, $identity->auth_environment_id);
        $this->assertSame(['super-admin'], $identity->roles);
        $this->assertSame(1, User::query()->count());
        $this->assertDatabaseHas('audit_logs', ['action' => 'install.admin_created', 'subject_id' => (string) $admin->id]);
        $this->assertDatabaseHas('audit_logs', ['action' => 'install.completed']);

        // no secret left behind
        $state = (string) file_get_contents($this->install->statePath());
        foreach ([PizzasysMock::SERVICE_TOKEN, 'nats-wizard-token', 'testing-wizard-token', self::ADMIN_PASSWORD] as $secret) {
            $this->assertStringNotContainsString($secret, $state);
        }
        $this->assertNull($this->install->read()['auth_environments']['environments']['production']['service_token']);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, (string) json_encode(AuditLog::query()->get()->toArray()));
        $this->assertDatabaseMissing('settings', ['value' => PizzasysMock::SERVICE_TOKEN]);

        // and the wizard is gone for good
        $this->get(route('setup.index'))->assertNotFound();
    }

    public function test_the_installed_app_lets_the_verified_admin_sign_in_through_the_portal(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();
        $this->runSteps();

        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::ADMIN_PASSWORD])
            ->assertRedirect(route('dashboard', absolute: false));

        $this->assertAuthenticatedAs(User::query()->where('email', 'admin@test.local')->sole());
        $this->assertSame(1, User::query()->count(), 'the wizard\'s shadow user is the one that signs in');
    }

    public function test_the_run_steps_are_idempotent(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();

        foreach (['run-migrations', 'seed-defaults', 'create-admin'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }
        foreach (['run-migrations', 'seed-defaults', 'create-admin'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }

        $this->assertSame(1, User::query()->count());
        $this->assertSame(1, UserExternalIdentity::query()->count());
        $this->assertSame(1, AuthEnvironment::query()->count());
    }

    public function test_the_environments_table_mirrors_the_answers_when_they_change_before_the_lock(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys(['environments' => ['testing' => ['base_url' => self::TESTING_URL, 'service_name' => 'x', 'service_token' => 'testing-token']]]);
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();
        $this->postJson(route('setup.run', 'run-migrations'));
        $this->postJson(route('setup.run', 'seed-defaults'));
        $this->assertSame(2, AuthEnvironment::query()->count());

        // the testing environment is removed again, the portal admin is re-verified
        $this->postPizzasys();
        $this->postPortalAdmin()->assertOk();
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame(1, AuthEnvironment::query()->count());
    }

    public function test_the_run_refuses_to_start_without_the_portal_answers_or_the_verified_admin(): void
    {
        $this->choosePizzasys();
        $this->postBasics();

        $this->postJson(route('setup.run', 'run-migrations'))->assertOk()->assertJsonPath('status', 'failed')->assertJsonPath('fields', ['pizzasys']);

        $this->postPizzasys();
        $this->postJson(route('setup.run', 'run-migrations'))->assertOk()->assertJsonPath('status', 'failed')->assertJsonPath('fields', ['portal-admin']);

        $this->postPortalAdmin()->assertOk();
        $this->postJson(route('setup.run', 'run-migrations'))->assertOk()->assertJsonPath('status', 'ok');
    }

    public function test_write_lock_refuses_a_portal_install_without_a_verified_admin(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();
        $this->postJson(route('setup.run', 'run-migrations'));
        $this->postJson(route('setup.run', 'seed-defaults'));
        // create-admin skipped on purpose; the client must not be able to lock an admin-less install
        $this->install->markRun('create-admin', 'done');

        $this->postJson(route('setup.run', 'write-lock'))
            ->assertOk()
            ->assertJsonPath('status', 'failed')
            ->assertJsonPath('message', 'No verified portal administrator exists yet. Sign in as a portal administrator before finishing.');

        $this->assertFileDoesNotExist($this->install->lockPath());
    }

    public function test_an_unreadable_stored_token_is_reported_instead_of_installing_a_broken_portal(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postPortalAdmin()->assertOk();
        $this->postBasics();
        $this->install->mutate(function (array $state): array {
            $state['auth_environments']['environments']['production']['service_token'] = 'not-an-encrypted-payload';

            return $state;
        });
        $this->postJson(route('setup.run', 'run-migrations'));

        $this->postJson(route('setup.run', 'seed-defaults'))
            ->assertOk()
            ->assertJsonPath('status', 'failed')
            ->assertJsonPath('message', 'The stored service token of the production environment cannot be read. Enter it again.');
        $this->assertSame(0, AuthEnvironment::query()->count());
    }

    public function test_nothing_the_wizard_does_calls_the_portals_refresh_endpoint(): void
    {
        $this->choosePizzasys();
        $this->postPizzasys();
        $this->postJson(route('setup.pizzasys.test'), ['env' => 'production']);
        $this->postPortalAdmin();

        Http::assertNotSent(fn ($request): bool => str_contains($request->url(), 'refresh-token'));
    }
}
