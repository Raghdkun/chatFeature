<?php

namespace Tests\Feature\Install;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;
use Inertia\Testing\AssertableInertia as Assert;

/**
 * The whole wizard through HTTP against an empty (in-memory) database and a temp state directory.
 */
class SetupWizardFlowTest extends InstallTestCase
{
    public function test_the_wizard_runs_end_to_end_in_mode_fortify(): void
    {
        // welcome -> token
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->component('setup/index')
            ->where('setup.step', 'welcome')
            ->where('setup.pizzasysAvailable', true)
            ->where('setup.pizzasys', null));
        $this->verifySetupToken();

        // mode
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'mode')->where('setup.mode', null));
        $this->chooseFortify();

        // admin
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'admin')->where('setup.mode', 'fortify'));
        $this->postAdmin('Owner@Example.test', 'a-long-test-password');

        // basics
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'basics')
            ->where('setup.admin', ['name' => 'Owner', 'email' => 'owner@example.test']));
        $this->postBasics();

        // run
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'run')
            ->where('setup.defaults.app_name', 'Acme Chat')
            ->where('setup.run.0.key', 'run-migrations')
            ->where('setup.run.0.status', 'pending')
            ->where('setup.run.3.key', 'write-lock'));

        $this->postJson(route('setup.run', 'run-migrations'))->assertOk()->assertExactJson(['status' => 'ok', 'next' => 'seed-defaults']);
        $this->postJson(route('setup.run', 'seed-defaults'))->assertOk()->assertExactJson(['status' => 'ok', 'next' => 'create-admin']);
        $this->postJson(route('setup.run', 'create-admin'))->assertOk()->assertExactJson(['status' => 'ok', 'next' => 'write-lock']);

        $this->assertFileDoesNotExist($this->install->lockPath());

        $this->postJson(route('setup.run', 'write-lock'))
            ->assertOk()
            ->assertExactJson(['status' => 'ok', 'next' => null, 'redirect' => '/login']);

        // result
        $this->assertFileExists($this->install->lockPath());
        $this->assertTrue($this->install->isInstalled());

        $admin = User::query()->where('email', 'owner@example.test')->firstOrFail();
        $this->assertSame('admin', $admin->role->value);
        $this->assertTrue($admin->is_admin);
        $this->assertTrue($admin->is_agent);
        $this->assertTrue($admin->is_active);
        $this->assertNotNull($admin->email_verified_at);
        $this->assertTrue(Hash::check('a-long-test-password', (string) $admin->password));

        $this->assertSame('Acme Chat', settings('app.name'));
        $this->assertSame('https://chat.acme.test', settings('app.url'));
        $this->assertSame('Europe/Berlin', settings('app.timezone'));
        $this->assertSame(90, settings('chat.default_idle_timeout_minutes'));
        $this->assertSame('fortify', settings('auth.mode'));
        $this->assertFalse(settings('auth.allow_registration'));
        $this->assertTrue(settings('app.installed'));
        $this->assertDatabaseHas('audit_logs', ['action' => 'install.completed']);

        // and the wizard is gone for good
        $this->get(route('setup.index'))->assertNotFound();
        $this->postJson(route('setup.run', 'write-lock'))->assertNotFound();
        $this->get('/')->assertRedirect(route('login'));
    }

    public function test_the_admin_password_is_stored_as_a_hash_only_and_is_scrubbed_after_creation(): void
    {
        $this->answerWizard();

        $state = (string) file_get_contents($this->install->statePath());
        $this->assertStringNotContainsString('a-long-test-password', $state);
        $this->assertTrue(Hash::check('a-long-test-password', (string) $this->install->read()['admin']['password_hash']));
        $this->assertSame('0600', substr(sprintf('%o', fileperms($this->install->statePath())), -4));

        $this->postJson(route('setup.run', 'run-migrations'))->assertOk();
        $this->postJson(route('setup.run', 'seed-defaults'))->assertOk();
        $this->postJson(route('setup.run', 'create-admin'))->assertOk();

        $this->assertNull($this->install->read()['admin']['password_hash']);
        $this->assertStringNotContainsString('a-long-test-password', (string) file_get_contents($this->install->statePath()));

        // answers already given never come back to the browser
        $this->assertStringNotContainsString('password', (string) json_encode($this->getJson(route('setup.state'))->json('setup.admin')));
    }

    public function test_state_endpoint_returns_the_same_shape_as_the_page_prop(): void
    {
        $this->answerWizard();

        $json = $this->getJson(route('setup.state'))->assertOk()->json('setup');

        $this->assertSame(['step', 'steps', 'needsToken', 'tokenVerified', 'mode', 'pizzasysAvailable', 'environment', 'defaults', 'admin', 'run', 'pizzasys'], array_keys($json));
        $this->assertSame('run', $json['step']);
        $this->assertSame(['ok', 'checks'], array_keys($json['environment']));
        $this->assertSame(['key', 'label', 'ok'], array_slice(array_keys($json['environment']['checks'][0]), 0, 3));
        $this->assertSame(['app_name', 'app_url', 'locale', 'timezone', 'idle_timeout_minutes'], array_keys($json['defaults']));
        $this->assertSame(['key', 'label', 'status'], array_keys($json['steps'][0]));
    }

    public function test_the_step_query_lets_the_ui_go_back_but_never_forward(): void
    {
        $this->answerWizard();

        $this->get(route('setup.index', ['step' => 'mode']))->assertInertia(fn (Assert $page) => $page
            ->where('setup.step', 'mode')
            ->where('setup.steps.1.status', 'current'));
        $this->get(route('setup.index', ['step' => 'done']))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'run'));
        $this->get(route('setup.index', ['step' => 'nonsense']))->assertInertia(fn (Assert $page) => $page->where('setup.step', 'run'));
    }

    public function test_form_validation_errors_come_back_as_inertia_errors(): void
    {
        $this->verifySetupToken();

        $this->post(route('setup.mode'), ['mode' => 'nonsense'])->assertSessionHasErrors('mode');
        $this->assertNull($this->install->mode());

        // admin form is only for mode fortify
        $this->post(route('setup.admin'), ['name' => 'A', 'email' => 'a@b.test', 'password' => 'a-long-test-password', 'password_confirmation' => 'a-long-test-password'])
            ->assertForbidden();

        $this->chooseFortify();

        $this->post(route('setup.admin'), ['name' => '', 'email' => 'not-an-email', 'password' => 'short', 'password_confirmation' => 'different'])
            ->assertSessionHasErrors(['name', 'email', 'password']);
        $this->assertNull($this->install->read()['admin']);

        $this->post(route('setup.basics'), ['app_name' => '', 'app_url' => 'javascript:alert(1)', 'locale' => 'xx', 'timezone' => 'Mars/Base', 'idle_timeout_minutes' => 0])
            ->assertSessionHasErrors(['app_name', 'app_url', 'locale', 'timezone', 'idle_timeout_minutes']);
        $this->assertNull($this->install->read()['basics']);
    }

    public function test_run_steps_refuse_to_start_before_the_answers_exist_or_out_of_order(): void
    {
        $this->verifySetupToken();

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertOk()
            ->assertJson(['status' => 'failed'])
            ->assertJsonPath('fields', ['mode', 'basics']);

        $this->answerWizardAfterToken();

        $this->postJson(route('setup.run', 'create-admin'))
            ->assertOk()
            ->assertJson(['status' => 'failed', 'message' => 'Complete the step "run-migrations" first.']);

        $this->postJson(route('setup.run', 'seed-defaults'))->assertJson(['status' => 'failed']);
        // none of the refused steps touched the (still empty) database
        $this->assertFalse(Schema::hasTable('settings'));
        $this->assertFalse(Schema::hasTable('users'));
    }

    public function test_unknown_run_steps_are_404(): void
    {
        $this->answerWizard();

        $this->postJson(route('setup.run', 'check-environment'))->assertNotFound();
        $this->postJson(route('setup.run', 'configure-pizzasys'))->assertNotFound();
        $this->postJson(route('setup.run', 'nope'))->assertNotFound();
    }

    public function test_run_steps_are_idempotent_and_resumable(): void
    {
        $this->answerWizard();

        foreach (['run-migrations', 'seed-defaults', 'create-admin'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }

        // run them all again, as a client resuming after a reload would
        foreach (['run-migrations', 'seed-defaults', 'create-admin'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }

        $this->assertSame(1, User::query()->where('email', 'owner@example.test')->count());
        $this->assertSame(1, Setting::query()->where('key', 'app.name')->count());

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.run.0.status', 'done')
            ->where('setup.run.1.status', 'done')
            ->where('setup.run.2.status', 'done')
            ->where('setup.run.3.status', 'pending'));
    }

    public function test_changing_the_answers_before_the_run_wins_over_earlier_seeded_values(): void
    {
        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'));
        $this->postJson(route('setup.run', 'seed-defaults'));

        $this->post(route('setup.basics'), [
            'app_name' => 'Renamed Chat', 'app_url' => 'https://other.test/', 'locale' => 'ar', 'timezone' => 'UTC', 'idle_timeout_minutes' => 30,
        ]);
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->install->writeLock();
        $this->assertSame('Renamed Chat', settings('app.name'));
        $this->assertSame('https://other.test', settings('app.url'));
        $this->assertSame('ar', settings('app.locale'));
        $this->assertSame(30, settings('chat.default_idle_timeout_minutes'));
    }

    public function test_changing_an_answer_resets_the_run_steps_that_consumed_it(): void
    {
        $this->answerWizard();
        foreach (['run-migrations', 'seed-defaults', 'create-admin'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }

        $this->postBasics();
        $this->getJson(route('setup.state'))
            ->assertJsonPath('setup.run.0.status', 'done')
            ->assertJsonPath('setup.run.1.status', 'pending')
            ->assertJsonPath('setup.run.2.status', 'done');

        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');
        $this->postAdmin('second@example.test');
        $this->getJson(route('setup.state'))
            ->assertJsonPath('setup.run.1.status', 'done')
            ->assertJsonPath('setup.run.2.status', 'pending');

        $this->postJson(route('setup.run', 'create-admin'))->assertJsonPath('status', 'ok');
        $this->assertDatabaseHas('users', ['email' => 'second@example.test', 'is_admin' => true]);
    }

    public function test_write_lock_refuses_without_an_administrator(): void
    {
        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'));
        $this->postJson(route('setup.run', 'seed-defaults'));
        // create-admin skipped on purpose; the client must not be able to lock an admin-less install
        $this->install->markRun('create-admin', 'done');

        $this->postJson(route('setup.run', 'write-lock'))
            ->assertOk()
            ->assertJsonPath('status', 'failed');

        $this->assertFileDoesNotExist($this->install->lockPath());
    }

    private function answerWizardAfterToken(): void
    {
        $this->chooseFortify();
        $this->postAdmin();
        $this->postBasics();
    }
}
