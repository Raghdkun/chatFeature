<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use App\Models\UserExternalIdentity;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

class ChatAuthCommandsTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private const TESTING_URL = 'https://auth-testing.example.test';

    private PizzasysMock $production;

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode();
        $this->useTestingEnvironment(self::TESTING_URL, ['nats_url' => 'nats://127.0.0.1:1']);
        $this->production = PizzasysMock::make()
            ->user('agent@test.local', 'pw', 'agent')
            ->user('admin@test.local', 'pw', 'admin')
            ->fake();
    }

    // ---- chat:auth:switch-env -----------------------------------------------------------------------------------

    public function test_the_break_glass_switch_needs_no_network_and_revokes_the_other_environments_sessions(): void
    {
        $result = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'pw'], 'phone');
        $this->assertTrue($result->isOk());
        Http::preventStrayRequests();
        $sent = Http::recorded()->count();
        Cache::put('auth.nats.restart', 9);

        $this->artisan('chat:auth:switch-env', ['env' => 'testing', '--force' => true])
            ->expectsOutputToContain('Active environment is now "testing"')
            ->assertExitCode(0);

        $this->assertSame('testing', settings('auth.pizzasys.active_env'));
        $this->assertSame($sent, Http::recorded()->count(), 'no network call');
        $this->assertSame(0, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(10, Cache::get('auth.nats.restart'));
        $this->assertSame(0, $this->production->calls('logout'), 'revocation by switching does not call the portal');

        $row = AuditLog::query()->where('action', 'auth.environment_activated')->sole();
        $this->assertNull($row->actor_id);
        $this->assertSame('cli', $row->changes['via']);
        $this->assertSame('production', $row->changes['from']);
        $this->assertSame('testing', $row->changes['to']);
    }

    public function test_the_switch_turns_the_nats_consumer_on_or_off_for_the_new_environment(): void
    {
        $this->assertFalse(settings('auth.pizzasys.nats.enabled'));

        $this->artisan('chat:auth:switch-env', ['env' => 'testing', '--force' => true])->assertExitCode(0);
        $this->assertTrue(settings('auth.pizzasys.nats.enabled'), 'the testing environment has a NATS URL');

        $this->artisan('chat:auth:switch-env', ['env' => 'production', '--force' => true])->assertExitCode(0);
        $this->assertFalse(settings('auth.pizzasys.nats.enabled'));
    }

    public function test_it_asks_for_confirmation_unless_forced(): void
    {
        $this->artisan('chat:auth:switch-env', ['env' => 'testing'])
            ->expectsConfirmation('Activate "testing" and sign every other user out?', 'no')
            ->assertExitCode(1);
        $this->assertSame('production', settings('auth.pizzasys.active_env'));

        $this->artisan('chat:auth:switch-env', ['env' => 'testing'])
            ->expectsConfirmation('Activate "testing" and sign every other user out?', 'yes')
            ->assertExitCode(0);
        $this->assertSame('testing', settings('auth.pizzasys.active_env'));
    }

    public function test_the_switch_refuses_bad_input(): void
    {
        $this->artisan('chat:auth:switch-env', ['env' => 'staging', '--force' => true])->assertExitCode(1);

        AuthEnvironment::query()->where('key', 'testing')->delete();
        $this->artisan('chat:auth:switch-env', ['env' => 'testing', '--force' => true])
            ->expectsOutputToContain('not configured')
            ->assertExitCode(1);

        $this->artisan('chat:auth:switch-env', ['env' => 'production', '--force' => true])
            ->expectsOutputToContain('already active')
            ->assertExitCode(0);
        $this->assertDatabaseMissing('audit_logs', ['action' => 'auth.environment_activated']);
    }

    public function test_the_switch_does_nothing_outside_mode_two_or_before_install(): void
    {
        settings()->set('auth.mode', 'fortify');
        $this->artisan('chat:auth:switch-env', ['env' => 'testing', '--force' => true])->assertExitCode(1);

        InstallStateFake::make(installed: false);
        $this->artisan('chat:auth:switch-env', ['env' => 'testing', '--force' => true])->assertExitCode(1);
    }

    // ---- chat:auth:test -----------------------------------------------------------------------------------------

    public function test_the_connection_test_prints_the_checks_and_remembers_the_result(): void
    {
        $exit = Artisan::call('chat:auth:test', ['env' => 'production']);
        $output = Artisan::output();

        $this->assertSame(0, $exit);
        $this->assertStringContainsString('Portal reachable', $output);
        $this->assertStringContainsString('Service credential accepted', $output);
        $this->assertStringContainsString('NATS events', $output);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $output);

        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('ok', $environment->last_check_status);
        $this->assertNotNull($environment->last_check_at);
        $this->assertNull($environment->last_check_message);
    }

    public function test_it_defaults_to_the_active_environment_and_reports_failures_with_a_non_zero_exit(): void
    {
        $this->production->rejectServiceCredential('Invalid service token.');

        $exit = Artisan::call('chat:auth:test');
        $output = Artisan::output();

        $this->assertSame(1, $exit);
        $this->assertStringContainsString('failed', $output);
        $environment = AuthEnvironment::query()->where('key', 'production')->sole();
        $this->assertSame('failed', $environment->last_check_status);
        $this->assertSame('The service token is not valid for this service.', $environment->last_check_message);
    }

    public function test_the_test_command_validates_its_input(): void
    {
        $this->artisan('chat:auth:test', ['env' => 'staging'])->assertExitCode(1);

        AuthEnvironment::query()->where('key', 'testing')->delete();
        $this->artisan('chat:auth:test', ['env' => 'testing'])->assertExitCode(1);
    }

    // ---- chat:auth:prune-sessions -------------------------------------------------------------------------------

    public function test_abandoned_sessions_are_revoked_and_their_upstream_token_closed(): void
    {
        $abandoned = ExternalSession::factory()->create(['last_verified_at' => now()->subHours(5)]);
        $active = ExternalSession::factory()->create(['last_verified_at' => now()->subMinutes(30)]);
        $mobile = ExternalSession::factory()->create(['sanctum_token_id' => 1, 'last_verified_at' => now()->subHours(5)]);
        $oldRevoked = ExternalSession::factory()->revoked()->create();
        $oldRevoked->forceFill(['revoked_at' => now()->subDays(45)])->save();
        $recentRevoked = ExternalSession::factory()->revoked()->create();

        $this->artisan('chat:auth:prune-sessions')
            ->expectsOutputToContain('Revoked 1 abandoned portal session(s); deleted 1 old revoked one(s).')
            ->assertExitCode(0);

        $this->assertNotNull($abandoned->fresh()->revoked_at);
        $this->assertSame('expired', $abandoned->fresh()->revoked_reason);
        $this->assertSame(1, $this->production->calls('logout'), 'the abandoned session\'s upstream token is closed (and only that one)');
        $this->assertNull($active->fresh()->revoked_at);
        $this->assertNull($mobile->fresh()->revoked_at, 'a mobile session lives as long as its token (30 days)');
        $this->assertNull(ExternalSession::query()->find($oldRevoked->id));
        $this->assertNotNull(ExternalSession::query()->find($recentRevoked->id));
    }

    public function test_it_is_scheduled_daily(): void
    {
        $events = collect(app(Schedule::class)->events())->filter(fn ($event): bool => str_contains((string) $event->command, 'chat:auth:prune-sessions'));

        $this->assertCount(1, $events);
        $this->assertSame('30 3 * * *', $events->first()->expression);
    }

    public function test_identities_are_untouched_by_pruning(): void
    {
        ExternalSession::factory()->create(['last_verified_at' => now()->subHours(5)]);

        $this->artisan('chat:auth:prune-sessions')->assertExitCode(0);

        $this->assertSame(1, UserExternalIdentity::query()->count());
    }
}
