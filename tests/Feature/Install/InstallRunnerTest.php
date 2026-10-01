<?php

namespace Tests\Feature\Install;

use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\InstallContext;
use App\Domain\Install\InstallLock;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\StepResult;
use App\Domain\Install\Steps\ConfigurePizzasysStep;
use App\Domain\Install\Steps\CreateAdminStep;
use App\Domain\Install\Steps\CreatePortalAdminStep;
use Illuminate\Support\Facades\Artisan;
use Inertia\Testing\AssertableInertia as Assert;
use Mockery;

class InstallRunnerTest extends InstallTestCase
{
    public function test_a_second_concurrent_run_gets_409(): void
    {
        $this->answerWizard();

        // Simulate another process that is running a step right now.
        $other = fopen($this->install->runningPath(), 'c');
        $this->assertNotFalse($other);
        $this->assertTrue(flock($other, LOCK_EX | LOCK_NB));

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertStatus(409)
            ->assertJson(['status' => 'failed', 'message' => 'Another installation run is already in progress.']);

        $this->assertFalse(app(InstallLock::class)->acquire());

        flock($other, LOCK_UN);
        fclose($other);

        $this->postJson(route('setup.run', 'run-migrations'))->assertOk()->assertJsonPath('status', 'ok');
    }

    public function test_the_lock_is_released_after_every_step_even_when_it_throws(): void
    {
        $lock = app(InstallLock::class);

        try {
            $lock->run(fn () => throw new \RuntimeException('boom'));
        } catch (\RuntimeException) {
        }

        $this->assertFalse($lock->isHeld());
        $this->assertTrue($lock->acquire());
        $this->assertTrue($lock->isHeld());
        $lock->release();
        $this->assertFalse($lock->isHeld());
    }

    public function test_run_all_refuses_when_another_run_holds_the_lock(): void
    {
        $other = fopen($this->install->runningPath(), 'c');
        $this->assertNotFalse($other);
        flock($other, LOCK_EX | LOCK_NB);

        $this->expectException(InstallBusyException::class);

        try {
            app(InstallRunner::class)->runAll();
        } finally {
            flock($other, LOCK_UN);
            fclose($other);
        }
    }

    public function test_a_stale_running_marker_without_a_held_lock_shows_as_pending(): void
    {
        $this->answerWizard();
        $this->install->markRun('run-migrations', 'running');

        $this->getJson(route('setup.state'))->assertJsonPath('setup.run.0.status', 'pending');

        $other = fopen($this->install->runningPath(), 'c');
        $this->assertNotFalse($other);
        flock($other, LOCK_EX | LOCK_NB);

        $this->getJson(route('setup.state'))->assertJsonPath('setup.run.0.status', 'running');

        flock($other, LOCK_UN);
        fclose($other);
    }

    public function test_a_failing_step_is_reported_recorded_and_can_be_retried(): void
    {
        $this->answerWizard();

        // Break the database for the first attempt.
        config(['database.connections.broken' => ['driver' => 'sqlite', 'database' => '/nonexistent/dir/nope.sqlite']]);
        config(['database.default' => 'broken']);

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertOk()
            ->assertJsonPath('status', 'failed')
            ->assertJsonStructure(['status', 'message']);

        $this->assertSame('failed', $this->install->runStatus('run-migrations'));

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.run.0.status', 'failed')
            ->has('setup.run.0.message'));

        config(['database.default' => 'sqlite']);

        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('status', 'ok');
        $this->assertSame('done', $this->install->runStatus('run-migrations'));
    }

    public function test_a_failing_migration_is_reported_with_its_message(): void
    {
        $this->answerWizard();

        Artisan::partialMock()->shouldReceive('call')->once()->with('migrate', ['--force' => true])
            ->andThrow(new \RuntimeException("SQLSTATE[42000]: Syntax error in migration\nsecond line"));

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertOk()
            ->assertJsonPath('status', 'failed')
            ->assertJsonPath('message', 'Migrations failed: SQLSTATE[42000]: Syntax error in migration');

        $this->assertSame('failed', $this->install->runStatus('run-migrations'));
    }

    public function test_an_unexpected_exception_in_a_step_becomes_a_failed_result(): void
    {
        $this->answerWizard();

        $boom = Mockery::mock(InstallStep::class);
        $boom->shouldReceive('key')->andReturn('run-migrations');
        $boom->shouldReceive('label')->andReturn('Boom');
        $boom->shouldReceive('modes')->andReturn(null);
        $boom->shouldReceive('run')->andThrow(new \RuntimeException('database exploded'));
        $this->app->instance('boom-step', $boom);
        config(['install.steps' => array_merge(['boom-step'], array_slice(config('install.steps'), 1))]);
        $this->app->forgetInstance(InstallRunner::class);

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertOk()
            ->assertJsonPath('status', 'failed')
            ->assertJsonPath('message', 'The step failed unexpectedly: database exploded');
    }

    public function test_the_pizzasys_step_asks_for_the_missing_wizard_answers(): void
    {
        $step = app(ConfigurePizzasysStep::class);

        $this->assertSame('configure-pizzasys', $step->key());
        $this->assertSame(['pizzasys'], $step->modes());

        $result = $step->run(InstallContext::fromState($this->install));
        $this->assertFalse($result->isOk());
        $this->assertSame(['pizzasys'], $result->fields);

        $keys = array_map(fn (InstallStep $step): string => $step->key(), app(InstallRunner::class)->steps());
        $this->assertSame(['check-environment', 'choose-mode', 'configure-pizzasys', 'app-basics', 'run-migrations', 'seed-defaults', 'create-admin', 'create-admin', 'write-lock'], $keys);

        // fortify never sees the pizzasys step, and each mode gets its own create-admin
        $fortify = array_map(fn (InstallStep $step): string => $step->key(), app(InstallRunner::class)->steps('fortify'));
        $this->assertNotContains('configure-pizzasys', $fortify);
        $this->assertSame(['create-admin'], array_values(array_filter($fortify, fn (string $key): bool => $key === 'create-admin')));

        $this->assertInstanceOf(CreateAdminStep::class, app(InstallRunner::class)->find('create-admin', 'fortify'));
        $this->assertInstanceOf(CreatePortalAdminStep::class, app(InstallRunner::class)->find('create-admin', 'pizzasys'));
        $this->assertSame(['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'], app(InstallRunner::class)->runKeys('pizzasys'));
    }

    public function test_step_results_carry_their_status(): void
    {
        $this->assertTrue(StepResult::ok()->isOk());
        $this->assertFalse(StepResult::failed('nope')->isOk());

        $needs = StepResult::needsInput(['mode', 'basics']);
        $this->assertSame(StepResult::NEEDS_INPUT, $needs->status);
        $this->assertSame(['mode', 'basics'], $needs->fields);
    }
}
