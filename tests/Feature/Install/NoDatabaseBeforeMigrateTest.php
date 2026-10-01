<?php

namespace Tests\Feature\Install;

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * The wizard must work with no database at all: nothing may query it before `run-migrations`.
 */
class NoDatabaseBeforeMigrateTest extends InstallTestCase
{
    /** @var list<string> */
    private array $queries = [];

    protected function setUp(): void
    {
        parent::setUp();

        DB::listen(function (QueryExecuted $query): void {
            $this->queries[] = $query->sql;
        });
    }

    public function test_the_wizard_screens_run_no_queries_at_all(): void
    {
        $this->get(route('setup.index'))->assertOk();
        $this->post(route('setup.token'), ['token' => self::TOKEN]);
        $this->get(route('setup.index'))->assertOk();
        $this->getJson(route('setup.state'))->assertOk();
        $this->chooseFortify();
        $this->postAdmin();
        $this->postBasics();
        $this->get(route('setup.index'))->assertOk();
        $this->getJson(route('setup.state'))->assertOk();

        $this->assertSame([], $this->queries, "Unexpected queries before migrate:\n".implode("\n", $this->queries));
    }

    public function test_gated_requests_and_the_health_check_run_no_queries(): void
    {
        $this->get('/')->assertRedirect('/setup');
        $this->get('/login')->assertRedirect('/setup');
        $this->getJson('/api/v1/me')->assertStatus(503);
        $this->get('/up')->assertOk();

        $this->assertSame([], $this->queries);
    }

    public function test_settings_and_shared_props_use_defaults_without_the_database(): void
    {
        $this->assertSame(config('app.name'), settings('app.name'));
        $this->assertSame('fortify', settings('auth.mode'));
        $this->assertFalse(settings('auth.allow_registration'));
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));

        $this->get(route('setup.index'))->assertOk();

        $this->assertSame([], $this->queries);
        $this->assertFalse(Schema::hasTable('settings'), 'the database is still empty');
    }

    public function test_the_database_is_only_touched_once_migrations_run(): void
    {
        $this->answerWizard();
        $this->assertSame([], $this->queries);

        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('status', 'ok');

        $this->assertNotEmpty($this->queries);
        $this->assertTrue(Schema::hasTable('settings'));
    }
}
