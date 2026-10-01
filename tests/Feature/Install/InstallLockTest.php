<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallContext;
use App\Domain\Install\Steps\WriteLockStep;
use App\Models\AuditLog;
use App\Models\Setting;
use Illuminate\Foundation\Testing\RefreshDatabase;

class InstallLockTest extends InstallTestCase
{
    use RefreshDatabase;

    public function test_writing_the_lock_is_idempotent(): void
    {
        $this->assertFalse($this->install->isInstalled());

        $this->install->writeLock(['mode' => 'fortify']);
        $first = (string) file_get_contents($this->install->lockPath());
        $this->install->writeLock(['mode' => 'fortify']);

        $this->assertTrue($this->install->isInstalled());
        $this->assertJson($first);
        $this->assertSame('fortify', json_decode($first, true)['mode']);
        $this->assertSame([], glob($this->install->directory().'/*.tmp'), 'no temporary files are left behind');
    }

    public function test_the_write_lock_step_can_run_twice(): void
    {
        $this->answerWizard();
        foreach (['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }

        // The wizard is now 404; the step itself stays harmless when invoked again (CLI, retries).
        $step = app(WriteLockStep::class);
        $result = $step->run(InstallContext::fromState($this->install));

        $this->assertTrue($result->isOk());
        $this->assertSame(1, AuditLog::query()->where('action', 'install.completed')->count());
    }

    public function test_a_database_flag_without_a_lock_file_restores_the_lock_instead_of_reinstalling(): void
    {
        $this->answerWizard();

        // The database says installed (restored dump / new container); the storage volume lost its lock.
        $this->assertDatabaseCount('settings', 0);
        Setting::factory()->create(['group' => 'app', 'key' => 'app.installed', 'value' => 'true']);
        $this->assertFalse($this->install->isInstalled());

        $this->postJson(route('setup.run', 'run-migrations'))
            ->assertOk()
            ->assertJsonPath('status', 'ok')
            ->assertJsonPath('next', null)
            ->assertJsonPath('redirect', '/login');

        $this->assertFileExists($this->install->lockPath());
        $this->assertTrue($this->install->isInstalled());
        $this->assertTrue(json_decode((string) file_get_contents($this->install->lockPath()), true)['recovered']);

        // nothing else was re-run: no admin got created, no defaults were rewritten
        $this->assertDatabaseCount('users', 0);
        $this->assertSame(1, Setting::query()->count());
        $this->get(route('setup.index'))->assertNotFound();
    }

    public function test_a_false_or_missing_database_flag_does_not_restore_anything(): void
    {
        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('next', 'seed-defaults');
        $this->assertFileDoesNotExist($this->install->lockPath());

        Setting::factory()->create(['group' => 'app', 'key' => 'app.installed', 'value' => 'false']);
        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('next', 'seed-defaults');
        $this->assertFileDoesNotExist($this->install->lockPath());
    }

    public function test_reset_removes_state_lock_and_run_lock(): void
    {
        $this->answerWizard();
        $this->install->writeLock();
        touch($this->install->runningPath());

        $this->install->reset();

        $this->assertFileDoesNotExist($this->install->statePath());
        $this->assertFileDoesNotExist($this->install->lockPath());
        $this->assertFileDoesNotExist($this->install->runningPath());
        $this->assertFalse($this->install->isInstalled());
    }

    public function test_state_survives_garbage_in_the_state_file(): void
    {
        file_put_contents($this->install->statePath(), '{not json');

        $state = $this->install->read();

        $this->assertNull($state['mode']);
        $this->assertNull($state['admin']);
        $this->assertSame([], $state['run']);
    }
}
