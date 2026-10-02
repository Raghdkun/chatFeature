<?php

namespace Tests\Feature\Notifications;

use App\Models\NotificationSetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\InteractsWithWebPush;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `GET/PUT /api/v1/me/notification-settings` (decisions P5-D4, P5-D7, P5-D9). */
class NotificationSettingsApiTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase, WidgetFixtures;

    private const URL = '/api/v1/me/notification-settings';

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useVapid();
        $this->agent = User::factory()->agent()->create(['timezone' => 'Asia/Riyadh']);
    }

    public function test_a_user_who_never_saved_anything_gets_the_defaults_and_no_row_is_created(): void
    {
        $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)
            ->assertOk()
            ->assertExactJson(['data' => [
                'sound' => true,
                'pushOffers' => true,
                'pushMessages' => true,
                'includePreview' => true,
                'quietHours' => ['enabled' => false, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'Asia/Riyadh'],
                'promptState' => 'never',
                'promptedAt' => null,
                'snoozedUntil' => null,
                'previewsAllowed' => true,
                'pushAvailable' => true,
                'snoozeDays' => 7,
            ]]);
        $this->assertSame(0, NotificationSetting::query()->count());
    }

    public function test_any_subset_can_be_saved_and_the_rest_stays(): void
    {
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['sound' => false, 'push_messages' => false])
            ->assertOk()
            ->assertJsonPath('data.sound', false)
            ->assertJsonPath('data.pushMessages', false)
            ->assertJsonPath('data.pushOffers', true)
            ->assertJsonPath('data.includePreview', true);

        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['include_preview' => false])
            ->assertOk()
            ->assertJsonPath('data.sound', false)
            ->assertJsonPath('data.includePreview', false);

        $row = NotificationSetting::query()->sole();
        $this->assertFalse($row->sound);
        $this->assertFalse($row->push_messages);
        $this->assertTrue($row->push_offers);
        $this->assertFalse($row->include_preview);
    }

    public function test_quiet_hours_are_saved_with_their_timezone_and_merged_field_by_field(): void
    {
        $this->actingAs($this->agent, 'sanctum')
            ->putJson(self::URL, ['quiet_hours' => ['enabled' => true, 'start' => '23:00', 'end' => '06:30', 'timezone' => 'Europe/Paris']])
            ->assertOk()
            ->assertJsonPath('data.quietHours', ['enabled' => true, 'start' => '23:00', 'end' => '06:30', 'timezone' => 'Europe/Paris']);

        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['quiet_hours' => ['end' => '08:00']])
            ->assertOk()
            ->assertJsonPath('data.quietHours', ['enabled' => true, 'start' => '23:00', 'end' => '08:00', 'timezone' => 'Europe/Paris']);

        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['quiet_hours' => ['enabled' => false]])
            ->assertJsonPath('data.quietHours.enabled', false)
            ->assertJsonPath('data.quietHours.start', '23:00');
    }

    public function test_quiet_hours_are_validated(): void
    {
        foreach ([
            'quiet_hours.start' => ['quiet_hours' => ['start' => '25:00']],
            'quiet_hours.end' => ['quiet_hours' => ['end' => '7am']],
            'quiet_hours.timezone' => ['quiet_hours' => ['timezone' => 'Mars/Olympus']],
            'quiet_hours.enabled' => ['quiet_hours' => ['enabled' => 'sometimes']],
        ] as $field => $body) {
            $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, $body)
                ->assertStatus(422)
                ->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => [$field]]]);
        }

        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['quiet_hours' => ['enabled' => true, 'start' => '08:00', 'end' => '08:00']])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['quiet_hours.end']]]);
        $this->assertSame(0, NotificationSetting::query()->count());
    }

    public function test_flags_must_be_booleans(): void
    {
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['sound' => 'loud'])->assertStatus(422);
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'maybe'])->assertStatus(422);
    }

    public function test_not_now_snoozes_for_seven_days_computed_by_the_server(): void
    {
        $this->travelTo(now()->startOfSecond());

        $response = $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'snoozed'])
            ->assertOk()
            ->assertJsonPath('data.promptState', 'snoozed');

        $this->assertSame(now()->addDays(7)->utc()->format('Y-m-d\TH:i:s.v\Z'), $response->json('data.snoozedUntil'));
        $this->assertNotNull($response->json('data.promptedAt'));
    }

    public function test_the_snooze_length_follows_the_configuration(): void
    {
        config(['push.snooze_days' => 3]);
        $this->travelTo(now()->startOfSecond());

        $response = $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'snoozed'])->assertOk();

        $this->assertSame(now()->addDays(3)->utc()->format('Y-m-d\TH:i:s.v\Z'), $response->json('data.snoozedUntil'));
    }

    public function test_granted_and_denied_clear_the_snooze_and_never_resets_the_dialog(): void
    {
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'snoozed'])->assertOk();

        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'granted'])
            ->assertJsonPath('data.promptState', 'granted')
            ->assertJsonPath('data.snoozedUntil', null);
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'denied'])
            ->assertJsonPath('data.promptState', 'denied');
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['prompt_state' => 'never'])
            ->assertJsonPath('data.promptState', 'never')
            ->assertJsonPath('data.snoozedUntil', null);
    }

    public function test_it_says_when_push_is_not_configured_and_when_previews_are_switched_off(): void
    {
        $this->withoutVapid();
        settings()->set('notifications.push_include_preview', false);

        $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)
            ->assertOk()
            ->assertJsonPath('data.pushAvailable', false)
            ->assertJsonPath('data.previewsAllowed', false);
    }

    public function test_every_user_only_ever_reads_and_changes_their_own_row(): void
    {
        $other = User::factory()->agent()->create();
        NotificationSetting::factory()->create(['user_id' => $other->id, 'sound' => false, 'push_offers' => false]);

        $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)->assertJsonPath('data.sound', true)->assertJsonPath('data.pushOffers', true);

        // A user id in the body is not a field: it cannot aim the change at somebody else.
        $this->actingAs($this->agent, 'sanctum')->putJson(self::URL, ['sound' => false, 'user_id' => $other->id])->assertOk();
        $this->assertSame(1, NotificationSetting::query()->where('user_id', $this->agent->id)->count());
        $this->assertFalse(NotificationSetting::query()->where('user_id', $other->id)->firstOrFail()->push_offers);
        $this->assertFalse(NotificationSetting::query()->where('user_id', $other->id)->firstOrFail()->sound);
    }

    public function test_admins_who_do_not_take_chats_have_settings_too(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')->putJson(self::URL, ['sound' => false])->assertOk()->assertJsonPath('data.sound', false);
    }

    public function test_guests_and_users_without_chat_access_are_turned_away(): void
    {
        $this->getJson(self::URL)->assertUnauthorized();
        $this->putJson(self::URL, ['sound' => false])->assertUnauthorized();

        $nobody = User::factory()->create(['is_admin' => false, 'is_agent' => false]);
        $this->actingAs($nobody, 'sanctum')->getJson(self::URL)->assertForbidden();
        $this->actingAs($nobody, 'sanctum')->putJson(self::URL, ['sound' => false])->assertForbidden();
        $this->assertSame(0, NotificationSetting::query()->count());
    }

    public function test_a_deactivated_user_is_turned_away(): void
    {
        $this->agent->forceFill(['is_active' => false])->save();

        $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)->assertStatus(401);
    }
}
