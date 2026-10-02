<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaAddressRefused;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaNotConfigured;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Models\AuditLog;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Settings > WhatsApp over the API: the API key is write-only and never returned, a changed address needs the key again, every value is
 * validated by its definition and written together or not at all, and the connection test answers with data, not errors.
 */
class WhatsAppSettingsApiTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private const KEY = 'owa_k1_the-real-key-0123456789abcdef';

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = $this->whatsAppPeople()['admin'];
        config(['chat.portal_allow_private_hosts' => true]);
    }

    private function api(): self
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    public function test_the_defaults_are_shown_and_no_key_is_saved(): void
    {
        $this->api()->getJson('/api/v1/whatsapp/settings')->assertOk()->assertExactJson(['data' => [
            'enabled' => false, 'baseUrl' => 'http://127.0.0.1:2785', 'hasApiKey' => false, 'handoffTtlMinutes' => 1440,
            'handoffText' => 'Hi! My support code is :code', 'ignoreGroups' => true, 'replyOnlyToInbound' => true,
            'sendMinIntervalMs' => 1500, 'dailySendCap' => 200, 'mediaMaxBytes' => 5 * 1024 * 1024,
            'retentionDays' => 0, 'rawRetentionDays' => 30,
        ]])->assertHeader('Cache-Control', 'no-store, private');
    }

    public function test_a_partial_update_changes_only_what_is_sent(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', ['enabled' => true, 'daily_send_cap' => 80, 'handoff_text' => 'Hello! Code :code'])
            ->assertOk()
            ->assertJsonPath('data.enabled', true)
            ->assertJsonPath('data.dailySendCap', 80)
            ->assertJsonPath('data.handoffText', 'Hello! Code :code')
            ->assertJsonPath('data.sendMinIntervalMs', 1500)
            ->assertJsonPath('data.ignoreGroups', true);

        $this->assertSame(80, settings()->int('whatsapp.daily_send_cap'));
        $this->assertTrue(settings()->bool('whatsapp.enabled'));
    }

    public function test_every_setting_can_be_changed(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', [
            'enabled' => true, 'base_url' => 'http://openwa:2785', 'handoff_ttl_minutes' => 60, 'handoff_text' => 'Code :code', 'ignore_groups' => false,
            'reply_only_to_inbound' => false, 'send_min_interval_ms' => 0, 'daily_send_cap' => 10_000, 'media_max_bytes' => 10_240,
            'retention_days' => 365, 'raw_retention_days' => 7,
        ])->assertOk()->assertJson(['data' => [
            'enabled' => true, 'baseUrl' => 'http://openwa:2785', 'hasApiKey' => false, 'handoffTtlMinutes' => 60, 'handoffText' => 'Code :code',
            'ignoreGroups' => false, 'replyOnlyToInbound' => false, 'sendMinIntervalMs' => 0, 'dailySendCap' => 10_000, 'mediaMaxBytes' => 10_240,
            'retentionDays' => 365, 'rawRetentionDays' => 7,
        ]]);
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalid(): iterable
    {
        yield 'a hand-off text without the code' => [['handoff_text' => 'Hello there'], 'handoff_text'];
        yield 'a hand-off text over two lines' => [['handoff_text' => "Hello\nCode :code"], 'handoff_text'];
        yield 'a hand-off lifetime too short' => [['handoff_ttl_minutes' => 4], 'handoff_ttl_minutes'];
        yield 'a hand-off lifetime too long' => [['handoff_ttl_minutes' => 10_081], 'handoff_ttl_minutes'];
        yield 'a negative interval' => [['send_min_interval_ms' => -1], 'send_min_interval_ms'];
        yield 'an interval over a minute' => [['send_min_interval_ms' => 60_001], 'send_min_interval_ms'];
        yield 'a zero cap' => [['daily_send_cap' => 0], 'daily_send_cap'];
        yield 'a huge cap' => [['daily_send_cap' => 10_001], 'daily_send_cap'];
        yield 'a tiny media limit' => [['media_max_bytes' => 100], 'media_max_bytes'];
        yield 'a huge media limit' => [['media_max_bytes' => 26_214_401], 'media_max_bytes'];
        yield 'a negative retention' => [['retention_days' => -1], 'retention_days'];
        yield 'a retention over ten years' => [['retention_days' => 3651], 'retention_days'];
        yield 'a negative raw retention' => [['raw_retention_days' => -1], 'raw_retention_days'];
        yield 'an address with a path' => [['base_url' => 'http://127.0.0.1:2785/api'], 'base_url'];
        yield 'an address with credentials' => [['base_url' => 'http://user:pass@127.0.0.1:2785'], 'base_url'];
        yield 'a metadata address' => [['base_url' => 'http://169.254.169.254'], 'base_url'];
        yield 'plain http on a public host' => [['base_url' => 'http://openwa.example.org'], 'base_url'];
        yield 'not an address' => [['base_url' => 'openwa'], 'base_url'];
        yield 'a key with a space' => [['api_key' => 'owa k1'], 'api_key'];
        yield 'a key with a line break' => [['api_key' => "owa_k1\nX-Evil: 1"], 'api_key'];
        yield 'a key over 255 characters' => [['api_key' => str_repeat('a', 256)], 'api_key'];
        yield 'a switch that is not a boolean' => [['enabled' => 'maybe'], 'enabled'];
        yield 'a number that is not a number' => [['daily_send_cap' => 'lots'], 'daily_send_cap'];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('invalid')]
    public function test_an_invalid_value_is_a_422_on_its_own_field(array $body, string $field): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', $body)->assertStatus(422)->assertJsonValidationErrors($field, 'error.details');
    }

    public function test_one_invalid_value_means_nothing_is_written(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', ['enabled' => true, 'daily_send_cap' => 80, 'handoff_text' => 'no placeholder'])->assertStatus(422);

        $this->assertFalse(settings()->bool('whatsapp.enabled'));
        $this->assertSame(200, settings()->int('whatsapp.daily_send_cap'));
    }

    public function test_the_api_key_is_write_only_and_encrypted_at_rest(): void
    {
        $response = $this->api()->putJson('/api/v1/whatsapp/settings', ['api_key' => self::KEY])->assertOk()->assertJsonPath('data.hasApiKey', true);

        $this->assertStringNotContainsString(self::KEY, $response->getContent());
        $this->assertStringNotContainsString(self::KEY, $this->api()->getJson('/api/v1/whatsapp/settings')->assertJsonPath('data.hasApiKey', true)->getContent());
        $this->assertSame(self::KEY, settings()->string('whatsapp.openwa.api_key'));

        $row = Setting::query()->where('key', 'whatsapp.openwa.api_key')->sole();
        $this->assertTrue((bool) $row->is_encrypted);
        $this->assertStringNotContainsString(self::KEY, (string) $row->value);
        $this->assertStringNotContainsString(self::KEY, json_encode(DB::table('settings')->get()->all()));
    }

    public function test_sending_other_settings_leaves_the_key_alone(): void
    {
        settings()->set('whatsapp.openwa.api_key', self::KEY);

        $this->api()->putJson('/api/v1/whatsapp/settings', ['daily_send_cap' => 90])->assertOk()->assertJsonPath('data.hasApiKey', true);

        $this->assertSame(self::KEY, settings()->string('whatsapp.openwa.api_key'));
    }

    public function test_a_changed_address_needs_the_key_in_the_same_request(): void
    {
        settings()->set('whatsapp.openwa.api_key', self::KEY);

        $this->api()->putJson('/api/v1/whatsapp/settings', ['base_url' => 'http://10.1.2.3:2785'])->assertStatus(422)->assertJsonValidationErrors('api_key', 'error.details');
        $this->assertSame('http://127.0.0.1:2785', settings()->string('whatsapp.openwa.base_url'));

        $this->api()->putJson('/api/v1/whatsapp/settings', ['base_url' => 'http://10.1.2.3:2785', 'api_key' => 'owa_k1_the-new-key-for-the-new-host'])->assertOk()->assertJsonPath('data.baseUrl', 'http://10.1.2.3:2785');
        $this->assertSame('owa_k1_the-new-key-for-the-new-host', settings()->string('whatsapp.openwa.api_key'));
    }

    public function test_the_same_address_spelled_with_a_trailing_slash_does_not_need_the_key(): void
    {
        settings()->set('whatsapp.openwa.api_key', self::KEY);

        $this->api()->putJson('/api/v1/whatsapp/settings', ['base_url' => 'http://127.0.0.1:2785/'])->assertOk();

        $this->assertSame(self::KEY, settings()->string('whatsapp.openwa.api_key'));
    }

    public function test_a_changed_address_with_no_key_saved_needs_none(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', ['base_url' => 'http://openwa:2785'])->assertOk();
    }

    public function test_the_key_can_be_removed(): void
    {
        settings()->set('whatsapp.openwa.api_key', self::KEY);

        $this->api()->putJson('/api/v1/whatsapp/settings', ['clear_api_key' => true])->assertOk()->assertJsonPath('data.hasApiKey', false);

        $this->assertSame('', settings()->string('whatsapp.openwa.api_key'));
        $this->assertSame(0, Setting::query()->where('key', 'whatsapp.openwa.api_key')->count());
        $this->assertSame('credential removed', 'credential '.AuditLog::query()->where('action', 'whatsapp.settings.updated')->sole()->changes['openwa_credential']);
    }

    public function test_the_audit_trail_names_the_changes_but_never_a_key(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', ['api_key' => self::KEY, 'daily_send_cap' => 77, 'enabled' => true])->assertOk();

        $audit = AuditLog::query()->where('action', 'whatsapp.settings.updated')->sole();
        $this->assertSame($this->admin->id, $audit->actor_id);
        $this->assertSame(['old' => 200, 'new' => 77], $audit->changes['whatsapp.daily_send_cap']);
        $this->assertSame('changed', $audit->changes['openwa_credential']);
        $this->assertStringNotContainsString(self::KEY, json_encode($audit->changes));
        $this->assertStringNotContainsString(self::KEY, json_encode(AuditLog::query()->get()->all()));
    }

    public function test_saving_nothing_new_writes_no_audit_row(): void
    {
        $this->api()->putJson('/api/v1/whatsapp/settings', ['daily_send_cap' => 200])->assertOk();

        $this->assertSame(0, AuditLog::query()->where('action', 'whatsapp.settings.updated')->count());
    }

    public function test_a_rejected_request_never_flashes_the_key_back(): void
    {
        $response = $this->api()->putJson('/api/v1/whatsapp/settings', ['api_key' => self::KEY, 'daily_send_cap' => 0]);

        $response->assertStatus(422);
        $this->assertStringNotContainsString(self::KEY, $response->getContent());
    }

    // ---- the connection test -----------------------------------------------------------------------------------------------

    public function test_the_test_reports_the_role_and_engine_of_a_working_key(): void
    {
        $this->openWa()->will('ping', new OpenWaPing('admin', 'baileys'));

        $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertOk()->assertExactJson(['data' => [
            'ok' => true, 'role' => 'admin', 'engine' => 'baileys', 'canOperate' => true, 'reason' => null, 'message' => null,
        ]]);
        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.settings.tested')->count());
    }

    public function test_a_key_that_can_only_read_is_a_success_with_a_warning(): void
    {
        $this->openWa()->will('ping', new OpenWaPing('viewer', 'whatsapp-web.js'));

        $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertOk()
            ->assertJsonPath('data.ok', true)->assertJsonPath('data.canOperate', false)->assertJsonPath('data.reason', 'insufficient_role');
    }

    /**
     * @return iterable<string, array{\Throwable, string}>
     */
    public static function failures(): iterable
    {
        yield 'no key' => [new OpenWaNotConfigured('no key'), 'not_configured'];
        yield 'blocked address' => [new OpenWaAddressRefused('no'), 'blocked'];
        yield 'down' => [new OpenWaUnavailable('OpenWA could not be reached.'), 'unreachable'];
        yield 'a 5xx' => [new OpenWaUnavailable('OpenWA answered HTTP 503.'), 'unreachable'];
        yield 'not OpenWA' => [new OpenWaUnavailable('OpenWA answered with something other than the documented JSON object.'), 'unexpected_response'];
        yield 'key refused' => [new OpenWaRejected('unauthorized', 401, 'Invalid API key'), 'unauthorized'];
        yield 'role refused' => [new OpenWaRejected('forbidden', 403, 'Forbidden'), 'unauthorized'];
        yield 'other refusal' => [new OpenWaRejected('bad_request', 400, 'x'), 'rejected'];
    }

    #[DataProvider('failures')]
    public function test_a_failing_test_is_data_with_a_reason_and_a_sentence_never_an_error_status(\Throwable $failure, string $reason): void
    {
        $this->openWa()->willThrow('ping', $failure);

        $response = $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertOk()->assertJsonPath('data.ok', false)->assertJsonPath('data.reason', $reason);

        $this->assertNotEmpty($response->json('data.message'));
        $this->assertStringNotContainsString('127.0.0.1', $response->getContent());
        $this->assertStringNotContainsString(self::KEY, $response->getContent());
    }

    public function test_the_test_is_limited_per_staff_member(): void
    {
        config(['whatsapp.admin_rate_limits.test' => 2]);

        $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertOk();
        $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertOk();
        $this->api()->postJson('/api/v1/whatsapp/settings/test')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
    }
}
