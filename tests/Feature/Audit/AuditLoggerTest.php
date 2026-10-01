<?php

namespace Tests\Feature\Audit;

use App\Domain\Audit\AuditLogger;
use App\Domain\Settings\Actions\UpdateSetting;
use App\Domain\Settings\SettingDefinition;
use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingsRegistry;
use App\Domain\Settings\SettingType;
use App\Models\AuditLog;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class AuditLoggerTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_records_actor_action_subject_and_changes(): void
    {
        $actor = User::factory()->admin()->create();
        $subject = User::factory()->create();

        $log = app(AuditLogger::class)->record('user.updated', $subject, ['role' => ['old' => 'agent', 'new' => 'admin']], $actor);

        $this->assertSame($actor->id, $log->actor_id);
        $this->assertSame('user.updated', $log->action);
        $this->assertSame(User::class, $log->subject_type);
        $this->assertSame((string) $subject->id, $log->subject_id);
        $this->assertSame(['role' => ['old' => 'agent', 'new' => 'admin']], $log->changes);
        $this->assertNotNull($log->created_at);
    }

    public function test_the_actor_defaults_to_the_signed_in_user_and_ip_and_user_agent_come_from_the_request(): void
    {
        $actor = User::factory()->admin()->create();

        Route::middleware('web')->get('/_audit-probe', fn () => response(app(AuditLogger::class)->record('probe.hit')->id));

        $response = $this->actingAs($actor)
            ->withHeader('User-Agent', 'AuditTest/1.0')
            ->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])
            ->get('/_audit-probe');

        $log = AuditLog::query()->findOrFail($response->getContent());
        $this->assertSame($actor->id, $log->actor_id);
        $this->assertSame('203.0.113.9', $log->ip_address);
        $this->assertSame('AuditTest/1.0', $log->user_agent);
    }

    public function test_it_records_system_actions_without_an_actor_or_network_details(): void
    {
        $log = app(AuditLogger::class)->record('install.completed', changes: ['mode' => 'fortify']);

        $this->assertNull($log->actor_id);
        $this->assertNull($log->subject_type);
        $this->assertNull($log->ip_address);
        $this->assertNull($log->user_agent);
        $this->assertSame(['mode' => 'fortify'], $log->changes);
    }

    public function test_secret_looking_values_are_redacted_at_any_depth(): void
    {
        $log = app(AuditLogger::class)->record('auth.environment.updated', changes: [
            'name' => 'testing',
            'service_token' => 'abc-123',
            'password' => 'hunter2',
            'nested' => ['client_secret' => 'xyz', 'url' => 'https://portal.test'],
        ]);

        $this->assertSame('testing', $log->changes['name']);
        $this->assertSame('[redacted]', $log->changes['service_token']);
        $this->assertSame('[redacted]', $log->changes['password']);
        $this->assertSame('[redacted]', $log->changes['nested']['client_secret']);
        $this->assertSame('https://portal.test', $log->changes['nested']['url']);
        $this->assertStringNotContainsString('hunter2', (string) json_encode(AuditLog::query()->latest('id')->first()?->getRawOriginal('changes')));
    }

    public function test_changing_a_setting_through_the_action_leaves_an_audit_trail_without_secrets(): void
    {
        app(SettingsRegistry::class)->define(new SettingDefinition('whatsapp.session_blob', SettingGroup::WhatsApp, SettingType::String, null, [], true, false));
        $admin = User::factory()->admin()->create();
        $update = app(UpdateSetting::class);

        $update('app.name', 'Acme Chat', $admin);
        $update('whatsapp.session_blob', 'sk-secret-value', $admin);

        $name = AuditLog::query()->where('action', 'settings.updated')->orderBy('id')->firstOrFail();
        $this->assertSame($admin->id, $name->actor_id);
        $this->assertSame(['app.name' => ['old' => config('app.name'), 'new' => 'Acme Chat']], $name->changes);
        $this->assertSame($admin->id, Setting::query()->where('key', 'app.name')->value('updated_by'));

        $secret = AuditLog::query()->where('action', 'settings.updated')->orderBy('id')->skip(1)->firstOrFail();
        $this->assertSame(['whatsapp.session_blob' => ['old' => '[encrypted]', 'new' => '[encrypted]']], $secret->changes);
        $this->assertStringNotContainsString('sk-secret-value', (string) json_encode($secret->getRawOriginal('changes')));
    }
}
