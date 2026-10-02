<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithWhatsAppWidgets;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The widget side of WhatsApp: `availability.whatsapp.enabled` and `config.features.whatsapp` are real (and say nothing about the number),
 * `whatsapp_connected` of the dashboard payloads follows the linked session, and the link API.
 */
class WhatsAppWidgetIntegrationTest extends TestCase
{
    use ChatFixtures, InteractsWithWhatsAppWidgets, RefreshDatabase, WhatsAppFixtures;

    private Widget $widget;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        [$this->widget] = $this->chatWidget();
        $this->admin = $this->whatsAppPeople()['admin'];
    }

    private function publicConfig(): array
    {
        return $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/config')->assertOk()->json('data');
    }

    private function publicAvailability(): array
    {
        return $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/availability')->assertOk()->json('data');
    }

    // ---- availability and the public config --------------------------------------------------------------------------------

    public function test_the_channel_is_offered_only_when_the_switch_the_feature_and_a_ready_session_all_hold(): void
    {
        $service = app(AvailabilityService::class);
        $this->assertFalse($service->forWidget($this->widget)->whatsapp->enabled, 'nothing is set up');

        settings()->set('whatsapp.enabled', true);
        $this->publishWhatsAppFeature($this->widget);
        $this->assertFalse($service->compute($this->widget->refresh(), now()->toImmutable())->whatsapp->enabled, 'no session linked');

        $session = WhatsAppSession::factory()->ready('+4915123456789')->create();
        $this->widget->forceFill(['whatsapp_session_id' => $session->id])->save();
        $this->assertTrue($service->compute($this->widget->refresh(), now()->toImmutable())->whatsapp->enabled);

        foreach ([
            'switch off' => fn () => settings()->set('whatsapp.enabled', false),
            'feature off' => fn () => $this->publishWhatsAppFeature($this->widget, false),
            'session not ready' => fn () => $session->forceFill(['status' => SessionStatus::Disconnected])->save(),
            'session without a number' => fn () => $session->forceFill(['phone_e164' => null])->save(),
            'session deleted' => fn () => $session->delete(),
        ] as $why => $break) {
            settings()->set('whatsapp.enabled', true);
            $this->publishWhatsAppFeature($this->widget);
            $session->forceFill(['status' => SessionStatus::Ready, 'phone_e164' => '+4915123456789', 'deleted_at' => null])->save();
            $this->assertTrue($service->compute($this->widget->refresh(), now()->toImmutable())->whatsapp->enabled, "before: {$why}");

            $break();
            $this->assertFalse($service->compute($this->widget->refresh(), now()->toImmutable())->whatsapp->enabled, $why);
        }
    }

    public function test_the_public_config_and_availability_agree_and_never_carry_the_number(): void
    {
        [$this->widget, $session] = $this->whatsAppWidget($this->widget, '+4915123456789');

        $config = $this->publicConfig();
        $availability = $this->publicAvailability();

        $this->assertTrue($config['config']['features']['whatsapp']);
        $this->assertTrue($config['availability']['whatsapp']['enabled']);
        $this->assertSame(['enabled' => true], $availability['whatsapp']);
        $this->assertSame(['enabled' => true], $config['availability']['whatsapp']);

        $everything = json_encode([$config, $availability]);
        $this->assertStringNotContainsString('4915123456789', $everything);
        $this->assertStringNotContainsString($session->ulid, $everything);
        $this->assertStringNotContainsString($session->name, $everything);
    }

    public function test_a_feature_that_is_off_or_unpublished_is_off_in_the_public_config_whatever_the_session_says(): void
    {
        [$this->widget] = $this->whatsAppWidget($this->widget);
        $this->publishWhatsAppFeature($this->widget, false);

        $this->assertFalse($this->publicConfig()['config']['features']['whatsapp']);
        $this->assertSame(['enabled' => false], $this->publicAvailability()['whatsapp']);
    }

    public function test_a_session_going_down_or_coming_up_is_visible_to_visitors_at_once_not_after_the_cache(): void
    {
        [$this->widget, $session] = $this->whatsAppWidget($this->widget);

        $this->assertTrue($this->publicConfig()['config']['features']['whatsapp'], 'cached now');

        app(ApplySessionState::class)->transition($session, SessionStatus::Disconnected);
        $this->assertSame(['enabled' => false], $this->publicAvailability()['whatsapp']);
        $this->assertFalse($this->publicConfig()['config']['features']['whatsapp']);

        app(ApplySessionState::class)->transition($session->refresh(), SessionStatus::Ready);
        $this->assertTrue($this->publicConfig()['config']['features']['whatsapp']);
    }

    // ---- the dashboard payloads --------------------------------------------------------------------------------------------

    public function test_whatsapp_connected_follows_the_linked_session(): void
    {
        $api = fn () => $this->actingAs($this->admin, 'sanctum');

        $api()->getJson('/api/v1/widgets/'.$this->widget->ulid)->assertOk()->assertJsonPath('data.whatsapp_connected', false);

        [, $session] = $this->whatsAppWidget($this->widget);
        $api()->getJson('/api/v1/widgets/'.$this->widget->ulid)->assertOk()->assertJsonPath('data.whatsapp_connected', true);

        $listed = collect($api()->getJson('/api/v1/widgets')->assertOk()->json('data'))->firstWhere('ulid', $this->widget->ulid);
        $this->assertTrue($listed['whatsapp_connected']);

        $session->forceFill(['status' => SessionStatus::Disconnected])->save();
        $api()->getJson('/api/v1/widgets/'.$this->widget->ulid)->assertJsonPath('data.whatsapp_connected', false);
    }

    // ---- the link API ------------------------------------------------------------------------------------------------------

    public function test_the_link_is_shown_set_and_removed(): void
    {
        $session = WhatsAppSession::factory()->ready('+4915123456789')->create(['name' => 'support-main']);
        $api = fn () => $this->actingAs($this->admin, 'sanctum');
        $url = '/api/v1/widgets/'.$this->widget->ulid.'/whatsapp';

        $api()->getJson($url)->assertOk()->assertExactJson(['data' => ['widget' => ['ulid' => $this->widget->ulid, 'name' => $this->widget->name], 'session' => null, 'status' => null, 'maskedPhone' => null, 'connected' => false]]);

        $api()->putJson($url, ['session' => $session->ulid])->assertOk()
            ->assertJsonPath('data.session', ['ulid' => $session->ulid, 'name' => 'support-main'])
            ->assertJsonPath('data.status', 'ready')
            ->assertJsonPath('data.connected', true)
            ->assertJsonPath('data.maskedPhone', $session->maskedPhone());
        $this->assertSame($session->id, $this->widget->refresh()->whatsapp_session_id);
        $this->assertSame(1, AuditLog::query()->where('action', 'widget.whatsapp_linked')->count());

        $api()->putJson($url, ['session' => null])->assertOk()->assertJsonPath('data.session', null)->assertJsonPath('data.connected', false);
        $this->assertNull($this->widget->refresh()->whatsapp_session_id);
        $this->assertSame(2, AuditLog::query()->where('action', 'widget.whatsapp_linked')->count());
    }

    public function test_linking_drops_the_cached_config_and_availability(): void
    {
        settings()->set('whatsapp.enabled', true);
        $this->publishWhatsAppFeature($this->widget);
        $session = WhatsAppSession::factory()->ready('+4915123456789')->create();

        $this->assertFalse($this->publicConfig()['config']['features']['whatsapp'], 'cached while unlinked');

        $this->actingAs($this->admin, 'sanctum')->putJson('/api/v1/widgets/'.$this->widget->ulid.'/whatsapp', ['session' => $session->ulid])->assertOk();

        $this->assertTrue($this->publicConfig()['config']['features']['whatsapp']);
        $this->assertSame(['enabled' => true], $this->publicAvailability()['whatsapp']);

        $this->actingAs($this->admin, 'sanctum')->putJson('/api/v1/widgets/'.$this->widget->ulid.'/whatsapp', ['session' => null])->assertOk();
        $this->assertSame(['enabled' => false], $this->publicAvailability()['whatsapp']);
    }

    public function test_the_link_needs_a_live_session_and_the_key(): void
    {
        $gone = WhatsAppSession::factory()->ready()->create();
        $gone->delete();
        $url = '/api/v1/widgets/'.$this->widget->ulid.'/whatsapp';
        $api = fn () => $this->actingAs($this->admin, 'sanctum');

        $api()->putJson($url, ['session' => $gone->ulid])->assertStatus(422)->assertJsonValidationErrors('session', 'error.details');
        $api()->putJson($url, ['session' => '01J9ZZZZZZZZZZZZZZZZZZZZZZ'])->assertStatus(422);
        $api()->putJson($url, ['session' => 'nope'])->assertStatus(422);
        $api()->putJson($url, [])->assertStatus(422)->assertJsonValidationErrors('session', 'error.details');
        $api()->putJson('/api/v1/widgets/01J9ZZZZZZZZZZZZZZZZZZZZZZ/whatsapp', ['session' => null])->assertNotFound();
    }

    public function test_a_deleted_widget_cannot_be_linked(): void
    {
        $url = '/api/v1/widgets/'.$this->widget->ulid.'/whatsapp';
        $this->widget->delete();

        $this->actingAs($this->admin, 'sanctum')->getJson($url)->assertNotFound();
    }
}
