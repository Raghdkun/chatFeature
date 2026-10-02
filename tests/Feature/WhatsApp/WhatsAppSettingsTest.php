<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingType;
use App\Models\Setting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The `whatsapp.*` settings (group WhatsApp): defaults, types, ranges, the OpenWA address guard, the hand-off text rule and the
 * API key that is encrypted at rest and never listed.
 */
class WhatsAppSettingsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return iterable<string, array{string, SettingType, mixed}>
     */
    public static function definitions(): iterable
    {
        yield 'enabled' => ['whatsapp.enabled', SettingType::Bool, false];
        yield 'base url' => ['whatsapp.openwa.base_url', SettingType::String, 'http://127.0.0.1:2785'];
        yield 'hand-off lifetime' => ['whatsapp.handoff_ttl_minutes', SettingType::Int, 1440];
        yield 'ignore groups' => ['whatsapp.ignore_groups', SettingType::Bool, true];
        yield 'reply only to inbound' => ['whatsapp.reply_only_to_inbound', SettingType::Bool, true];
        yield 'send interval' => ['whatsapp.send_min_interval_ms', SettingType::Int, 1500];
        yield 'daily cap' => ['whatsapp.daily_send_cap', SettingType::Int, 200];
        yield 'hand-off text' => ['whatsapp.handoff_text', SettingType::String, 'Hi! My support code is :code'];
        yield 'media size' => ['whatsapp.media_max_bytes', SettingType::Int, 5 * 1024 * 1024];
    }

    #[DataProvider('definitions')]
    public function test_the_setting_has_its_documented_default_type_and_group(string $key, SettingType $type, mixed $default): void
    {
        $definition = settings()->registry()->require($key);

        $this->assertSame(SettingGroup::WhatsApp, $definition->group);
        $this->assertSame($type, $definition->type);
        $this->assertSame($default, $definition->defaultValue());
        $this->assertSame($default, settings($key));
        $this->assertFalse($definition->encrypted);

        // The address default is loopback, which a production install may not even save (see below): it is served, not seeded.
        $this->assertSame($key !== 'whatsapp.openwa.base_url', $definition->seed, $key);
    }

    public function test_a_fresh_install_seeds_the_defaults_even_where_the_loopback_address_would_not_validate(): void
    {
        config(['chat.portal_allow_private_hosts' => false]);
        $seeded = [];

        foreach (settings()->registry()->all() as $key => $definition) {
            if ($definition->seed && str_starts_with($key, 'whatsapp.')) {
                $this->assertTrue(settings()->seedMissing($key, $definition->defaultValue()), $key);
                $seeded[] = $key;
            }
        }

        $this->assertNotContains('whatsapp.openwa.base_url', $seeded);
        $this->assertNotContains('whatsapp.openwa.api_key', $seeded);
        $this->assertContains('whatsapp.handoff_text', $seeded);
        $this->assertSame('http://127.0.0.1:2785', settings('whatsapp.openwa.base_url'), 'the default still applies');
    }

    /**
     * @return iterable<string, array{string, int, int}>
     */
    public static function ranges(): iterable
    {
        yield 'hand-off lifetime (minutes)' => ['whatsapp.handoff_ttl_minutes', 5, 10_080];
        yield 'send interval (ms)' => ['whatsapp.send_min_interval_ms', 0, 60_000];
        yield 'daily cap' => ['whatsapp.daily_send_cap', 1, 10_000];
        yield 'media size (bytes)' => ['whatsapp.media_max_bytes', 10_240, 26_214_400];
    }

    #[DataProvider('ranges')]
    public function test_a_number_accepts_its_range_and_refuses_outside_it(string $key, int $min, int $max): void
    {
        settings()->set($key, $min);
        $this->assertSame($min, settings()->int($key));

        settings()->set($key, $max);
        $this->assertSame($max, settings()->int($key));

        foreach ([$min - 1, $max + 1, 'many'] as $invalid) {
            $this->assertRefused($key, $invalid);
        }

        $this->assertSame($max, settings()->int($key), 'a refused value changes nothing');
    }

    public function test_the_switches_are_booleans_and_stored_as_such(): void
    {
        foreach (['whatsapp.enabled', 'whatsapp.ignore_groups', 'whatsapp.reply_only_to_inbound'] as $key) {
            settings()->set($key, true);
            $this->assertTrue(settings()->bool($key));

            settings()->set($key, false);
            $this->assertFalse(settings()->bool($key));
        }
    }

    private function assertRefused(string $key, mixed $value): void
    {
        try {
            settings()->set($key, $value);
            $this->fail("{$key} accepted ".json_encode($value));
        } catch (ValidationException $exception) {
            $this->assertArrayHasKey($key, $exception->errors());
        }
    }

    // ---- the OpenWA address ------------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{string}>
     */
    public static function addressesOnAPrivateNetwork(): iterable
    {
        yield 'loopback' => ['http://127.0.0.1:2785'];
        yield 'localhost' => ['http://localhost:2785'];
        yield 'ipv6 loopback' => ['http://[::1]:2785'];
        yield 'docker service name' => ['http://openwa:2785'];
        yield 'private ipv4' => ['http://10.0.0.5:2785'];
        yield 'trailing slash' => ['http://127.0.0.1:2785/'];
        yield 'https on loopback' => ['https://127.0.0.1:2785'];
        yield 'default port' => ['http://openwa'];
    }

    #[DataProvider('addressesOnAPrivateNetwork')]
    public function test_a_private_address_is_accepted_only_when_private_hosts_are_allowed(string $url): void
    {
        config(['chat.portal_allow_private_hosts' => false]);
        $this->assertRefused('whatsapp.openwa.base_url', $url);

        config(['chat.portal_allow_private_hosts' => true]);
        settings()->set('whatsapp.openwa.base_url', $url);
        $this->assertSame($url, settings('whatsapp.openwa.base_url'));
    }

    public function test_a_public_host_needs_https(): void
    {
        config(['chat.portal_allow_private_hosts' => false]);

        settings()->set('whatsapp.openwa.base_url', 'https://openwa.example.com');
        settings()->set('whatsapp.openwa.base_url', 'https://openwa.example.com:8443');
        $this->assertRefused('whatsapp.openwa.base_url', 'http://openwa.example.com');
        $this->assertRefused('whatsapp.openwa.base_url', 'http://openwa.example.com:2785');
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function addressesThatAreNeverAccepted(): iterable
    {
        yield 'no scheme' => ['openwa.example.com:2785'];
        yield 'ftp' => ['ftp://openwa.example.com'];
        yield 'credentials' => ['https://user:pass@openwa.example.com'];
        yield 'an api path' => ['https://openwa.example.com/api'];
        yield 'a query' => ['https://openwa.example.com/?key=1'];
        yield 'a fragment' => ['https://openwa.example.com/#x'];
        yield 'cloud metadata address' => ['http://169.254.169.254'];
        yield 'cloud metadata name' => ['http://metadata.google.internal'];
        yield 'unspecified address' => ['http://0.0.0.0:2785'];
        yield 'unspecified ipv6' => ['http://[::]:2785'];
        yield 'link-local' => ['http://169.254.10.10:2785'];
        yield 'numeric spelling of loopback' => ['http://2130706433:2785'];
        yield 'hex spelling' => ['http://0x7f000001:2785'];
        yield 'short spelling' => ['http://127.1:2785'];
        yield 'spaces' => ['http://open wa:2785'];
        yield 'backslash' => ['http:\\\\openwa.example.com'];
        yield 'empty' => [''];
    }

    #[DataProvider('addressesThatAreNeverAccepted')]
    public function test_these_addresses_are_refused_even_when_private_hosts_are_allowed(string $url): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertRefused('whatsapp.openwa.base_url', $url);
    }

    public function test_an_overlong_address_is_refused(): void
    {
        $this->assertRefused('whatsapp.openwa.base_url', 'https://'.str_repeat('a', 250).'.example.com');
    }

    // ---- the API key -------------------------------------------------------------------------------------------------------

    public function test_the_api_key_is_encrypted_at_rest_never_seeded_and_never_listed(): void
    {
        $definition = settings()->registry()->require('whatsapp.openwa.api_key');

        $this->assertSame(SettingGroup::WhatsApp, $definition->group);
        $this->assertTrue($definition->encrypted);
        $this->assertFalse($definition->seed, 'a fresh install must not write an empty key');
        $this->assertNull(settings('whatsapp.openwa.api_key'));
        $this->assertFalse(settings()->has('whatsapp.openwa.api_key'));

        settings()->set('whatsapp.openwa.api_key', 'owa_k1_this-is-the-key');

        $row = Setting::query()->where('key', 'whatsapp.openwa.api_key')->firstOrFail();
        $this->assertTrue($row->is_encrypted);
        $this->assertStringNotContainsString('owa_k1_this-is-the-key', (string) $row->value);
        $this->assertSame('owa_k1_this-is-the-key', settings('whatsapp.openwa.api_key'));
        $this->assertTrue(settings()->has('whatsapp.openwa.api_key'));
        $this->assertArrayNotHasKey('whatsapp.openwa.api_key', settings()->all());
        $this->assertStringNotContainsString('owa_k1_this-is-the-key', (string) json_encode(settings()->all()));
    }

    public function test_the_api_key_can_be_cleared_and_is_bounded(): void
    {
        settings()->set('whatsapp.openwa.api_key', 'owa_k1_abc');
        settings()->set('whatsapp.openwa.api_key', null);

        $this->assertNull(settings('whatsapp.openwa.api_key'));
        $this->assertRefused('whatsapp.openwa.api_key', str_repeat('k', 256));
    }

    // ---- the hand-off text -------------------------------------------------------------------------------------------------

    public function test_the_handoff_text_must_carry_the_code_placeholder(): void
    {
        settings()->set('whatsapp.handoff_text', 'Hallo! Mein Support-Code ist :code');
        $this->assertSame('Hallo! Mein Support-Code ist :code', settings('whatsapp.handoff_text'));

        settings()->set('whatsapp.handoff_text', ':code');
        $this->assertSame(':code', settings('whatsapp.handoff_text'));

        $this->assertRefused('whatsapp.handoff_text', 'Hello, I need help');
        $this->assertRefused('whatsapp.handoff_text', 'Code: CODE');
    }

    public function test_the_handoff_text_is_one_short_line(): void
    {
        $this->assertRefused('whatsapp.handoff_text', '');
        $this->assertRefused('whatsapp.handoff_text', '   ');
        $this->assertRefused('whatsapp.handoff_text', "Hi\nMy code is :code");
        $this->assertRefused('whatsapp.handoff_text', "Hi\tcode :code");
        $this->assertRefused('whatsapp.handoff_text', str_repeat('x', 200).' :code');

        settings()->set('whatsapp.handoff_text', str_repeat('x', 190).' :code');
        $this->assertSame(196, mb_strlen(settings()->string('whatsapp.handoff_text')));
    }

    public function test_the_other_groups_are_untouched(): void
    {
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));
        $this->assertSame('fortify', settings('auth.mode'));
    }
}
