<?php

namespace Tests\Feature\Settings;

use App\Domain\Install\InstallState;
use App\Domain\Settings\Exceptions\UnknownSettingException;
use App\Domain\Settings\Facades\Settings;
use App\Domain\Settings\SettingDefinition;
use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingsRegistry;
use App\Domain\Settings\SettingsRepository;
use App\Domain\Settings\SettingType;
use App\Models\Setting;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class SettingsRepositoryTest extends TestCase
{
    use RefreshDatabase;

    private SettingsRepository $settings;

    protected function setUp(): void
    {
        parent::setUp();

        app(SettingsRegistry::class)->define(new SettingDefinition(
            'whatsapp.api_key',
            SettingGroup::WhatsApp,
            SettingType::String,
            default: null,
            encrypted: true,
            seed: false,
        ));

        $this->settings = app(SettingsRepository::class);
    }

    public function test_the_shipped_definitions_have_the_documented_defaults(): void
    {
        $this->assertSame(config('app.name'), settings('app.name'));
        $this->assertSame(config('app.url'), settings('app.url'));
        $this->assertSame(config('app.locale'), settings('app.locale'));
        $this->assertSame('UTC', settings('app.timezone'));
        $this->assertFalse(settings('app.installed'));
        $this->assertSame('fortify', settings('auth.mode'));
        $this->assertFalse(settings('auth.allow_registration'));
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));
    }

    public function test_before_install_defaults_come_back_without_touching_the_database_or_the_cache(): void
    {
        InstallState::fake(installed: false);
        Schema::drop('settings');
        Cache::spy();

        $queries = [];
        DB::listen(function (QueryExecuted $query) use (&$queries): void {
            $queries[] = $query->sql;
        });

        $this->assertSame(config('app.name'), settings('app.name'));
        $this->assertSame('fortify', settings('auth.mode'));
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));
        $this->assertSame('fallback', settings('not.defined', 'fallback'));
        $this->assertSame([], $queries);
        Cache::shouldNotHaveReceived('remember');
        Cache::shouldNotHaveReceived('get');
    }

    public function test_values_round_trip_with_their_types(): void
    {
        $this->settings->set('app.name', 'Acme');
        $this->settings->set('auth.allow_registration', true);
        $this->settings->set('chat.default_idle_timeout_minutes', '45');

        $this->assertSame('Acme', settings('app.name'));
        $this->assertTrue(settings('auth.allow_registration'));
        $this->assertSame(45, settings('chat.default_idle_timeout_minutes'));

        $this->assertSame('Acme', $this->settings->string('app.name'));
        $this->assertTrue($this->settings->bool('auth.allow_registration'));
        $this->assertSame(45, $this->settings->int('chat.default_idle_timeout_minutes'));
        $this->assertSame('Acme', Settings::get('app.name'));
        $this->assertSame($this->settings, settings());
    }

    public function test_setting_a_key_twice_updates_the_single_row(): void
    {
        $this->settings->set('app.name', 'One', updatedBy: null);
        $this->settings->set('app.name', 'Two');

        $this->assertSame(1, Setting::query()->where('key', 'app.name')->count());
        $this->assertSame('Two', settings('app.name'));
        $this->assertSame('app', Setting::query()->where('key', 'app.name')->value('group'));
    }

    public function test_encrypted_values_round_trip_and_are_never_stored_in_plain_text(): void
    {
        $this->settings->set('whatsapp.api_key', 'sk-live-very-secret');

        $row = Setting::query()->where('key', 'whatsapp.api_key')->firstOrFail();
        $this->assertTrue($row->is_encrypted);
        $this->assertStringNotContainsString('very-secret', (string) $row->value);
        $this->assertSame('sk-live-very-secret', settings('whatsapp.api_key'));

        // not in the cache in plain text either
        $cached = json_encode(Cache::get(SettingsRepository::CACHE_PREFIX.'0'));
        $this->assertNotFalse($cached);
        $this->assertStringNotContainsString('very-secret', $cached);

        // and a fresh repository (new request) still reads it
        $this->app->forgetInstance(SettingsRepository::class);
        $this->assertSame('sk-live-very-secret', settings('whatsapp.api_key'));
    }

    public function test_all_leaves_encrypted_settings_out(): void
    {
        $this->settings->set('whatsapp.api_key', 'sk-secret');

        $all = $this->settings->all();

        $this->assertArrayHasKey('app.name', $all);
        $this->assertArrayNotHasKey('whatsapp.api_key', $all);
    }

    public function test_an_undecryptable_value_falls_back_to_the_default_instead_of_breaking_pages(): void
    {
        Setting::query()->create(['group' => 'whatsapp', 'key' => 'whatsapp.api_key', 'value' => 'garbage-ciphertext', 'is_encrypted' => true]);

        $this->assertNull(settings('whatsapp.api_key'));
    }

    public function test_reads_are_cached_and_writes_invalidate_the_cache(): void
    {
        $this->settings->set('app.name', 'First');
        $this->settings->forget();

        $queries = 0;
        DB::listen(function () use (&$queries): void {
            $queries++;
        });

        $this->assertSame('First', settings('app.name'));
        $this->assertSame('First', settings('app.name'));
        $this->assertSame('First', settings('auth.mode') === 'fortify' ? settings('app.name') : '');
        $this->assertSame(1, $queries, 'one query loads every setting, later reads are served from memory/cache');

        // a write elsewhere is invisible until the cache is dropped ...
        Setting::query()->where('key', 'app.name')->update(['value' => json_encode('Sneaky')]);
        $this->assertSame('First', settings('app.name'));

        // ... and set() invalidates by itself
        $this->settings->set('app.name', 'Second');
        $this->assertSame('Second', settings('app.name'));

        // a brand-new repository instance (next request) is served from the shared cache
        $this->app->forgetInstance(SettingsRepository::class);
        $queries = 0;
        $this->assertSame('Second', settings('app.name'));
        $this->assertSame(0, $queries);
    }

    public function test_invalid_values_are_rejected_under_the_setting_key(): void
    {
        try {
            $this->settings->set('chat.default_idle_timeout_minutes', 0);
            $this->fail('A validation error was expected.');
        } catch (ValidationException $exception) {
            $this->assertArrayHasKey('chat.default_idle_timeout_minutes', $exception->errors());
        }

        $this->assertThrows(fn () => $this->settings->set('app.locale', 'zz'), ValidationException::class);
        $this->assertThrows(fn () => $this->settings->set('app.url', 'javascript:alert(1)'), ValidationException::class);
        $this->assertThrows(fn () => $this->settings->set('auth.mode', 'ldap'), ValidationException::class);
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));
    }

    public function test_unknown_settings_cannot_be_written(): void
    {
        $this->expectException(UnknownSettingException::class);

        $this->settings->set('does.not.exist', 'x');
    }

    public function test_workspaces_are_isolated_from_the_global_scope(): void
    {
        $this->settings->set('app.name', 'Global');
        $this->settings->set('app.name', 'Tenant five', workspaceId: 5);

        $this->assertSame('Global', settings('app.name'));
        $this->assertSame('Tenant five', $this->settings->get('app.name', workspaceId: 5));
        $this->assertSame(config('app.name'), $this->settings->get('app.name', workspaceId: 6));
    }

    public function test_the_database_enforces_one_global_row_per_key(): void
    {
        $row = ['group' => 'app', 'key' => 'app.name', 'value' => '"x"', 'workspace_id' => null];
        Setting::query()->create($row);

        // NULL workspace_id would not collide in a plain MySQL unique index; workspace_key = COALESCE(workspace_id, 0) does.
        $this->assertThrows(fn () => Setting::query()->create($row), UniqueConstraintViolationException::class);

        // the same key in a real workspace is fine
        Setting::query()->create([...$row, 'workspace_id' => 3]);
        $this->assertSame(0, Setting::query()->where('key', 'app.name')->whereNull('workspace_id')->value('workspace_key'));
    }

    public function test_seed_missing_never_overwrites(): void
    {
        $this->assertTrue($this->settings->seedMissing('app.name', 'Seeded'));
        $this->assertFalse($this->settings->seedMissing('app.name', 'Other'));

        $this->assertSame('Seeded', settings('app.name'));
    }
}
