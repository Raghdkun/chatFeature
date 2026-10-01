<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallState;
use Illuminate\Foundation\Testing\RefreshDatabase;

class InstallGateTest extends InstallTestCase
{
    use RefreshDatabase;

    public function test_web_requests_are_redirected_to_the_wizard_before_install(): void
    {
        $this->get('/')->assertRedirect('/setup');
        $this->get('/login')->assertRedirect('/setup');
        $this->get('/dashboard')->assertRedirect('/setup');
        $this->post('/login', ['email' => 'a@b.test', 'password' => 'x'])->assertRedirect('/setup');
    }

    public function test_api_and_json_requests_get_503_not_installed_before_install(): void
    {
        $this->getJson('/api/v1/me')->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
        $this->getJson('/dashboard')->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
        $this->postJson('/api/v1/public/anything')->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
        $this->get('/api/v1/me')->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
        $this->post('/webhooks/openwa/abc')->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
    }

    public function test_health_check_the_wizard_and_static_assets_are_exempt(): void
    {
        $this->get('/up')->assertOk();
        $this->get('/setup')->assertOk();

        // Not redirected to the wizard: they fall through to the router (and 404 there, since the
        // web server normally serves these files straight from public/).
        $this->get('/favicon.ico')->assertNotFound();
        $this->get('/build/assets/missing.js')->assertNotFound();
        $this->get('/robots.txt')->assertNotFound();
    }

    public function test_a_missing_app_key_is_explained_instead_of_crashing_the_wizard(): void
    {
        config(['app.key' => '']);

        $this->get('/setup')
            ->assertStatus(503)
            ->assertSee('APP_KEY is missing')
            ->assertSee('chat:bootstrap-secrets');

        $this->get('/up')->assertOk();
    }

    public function test_the_gate_is_a_no_op_once_installed(): void
    {
        $this->install->writeLock();

        $this->get('/login')->assertOk();
        $this->getJson('/api/v1/not-a-route')->assertNotFound();
        $this->getJson('/dashboard')->assertUnauthorized();
        $this->get('/dashboard')->assertRedirect(route('login'));
    }

    public function test_every_setup_url_is_404_once_installed(): void
    {
        $this->install->writeLock();

        $this->get('/setup')->assertNotFound();
        $this->get('/setup/state')->assertNotFound();
        $this->post('/setup/token', ['token' => self::TOKEN])->assertNotFound();
        $this->post('/setup/mode', ['mode' => 'fortify'])->assertNotFound();
        $this->post('/setup/admin', [])->assertNotFound();
        $this->post('/setup/basics', [])->assertNotFound();
        $this->postJson('/setup/run/write-lock')->assertNotFound();
        $this->get('/setup/anything-else')->assertNotFound();
    }

    public function test_the_app_installed_env_override_counts_as_installed(): void
    {
        config(['install.installed' => true]);
        $state = new InstallState($this->install->directory());

        $this->assertTrue($state->isInstalled());
        $this->assertFileDoesNotExist($state->lockPath());
    }

    public function test_the_testing_environment_counts_as_installed_unless_it_opts_out(): void
    {
        $this->assertTrue($this->app->environment('testing'));

        // A fresh container binding (not faked) in the testing environment is "installed".
        $this->app->forgetInstance(InstallState::class);
        $this->assertTrue(app(InstallState::class)->isInstalled());

        // Opting out: nothing forced, and the (empty) temp directory has no lock file.
        config(['install.installed' => false, 'install.directory' => $this->install->directory()]);
        $this->app->forgetInstance(InstallState::class);
        $this->assertFalse(app(InstallState::class)->isInstalled());
    }
}
