<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Enums\PromptState;
use App\Models\DeviceToken;
use App\Models\NotificationSetting;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** The tables behind push (decision P5-D4): constraints, casts, cascades. Runs on SQLite by default and on MySQL with DB_CONNECTION=mysql. */
class NotificationSchemaTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_subscription_endpoint_is_unique_across_users(): void
    {
        $subscription = PushSubscription::factory()->create();

        $this->expectException(QueryException::class);
        PushSubscription::factory()->forEndpoint($subscription->endpoint)->create();
    }

    public function test_a_long_endpoint_fits_and_is_found_by_its_hash(): void
    {
        $endpoint = 'https://wns2-par02p.notify.windows.com/w/?token='.str_repeat('A', 1800);
        $created = PushSubscription::factory()->forEndpoint($endpoint)->create();

        $found = PushSubscription::query()->where('endpoint_hash', PushSubscription::hashEndpoint($endpoint))->sole();

        $this->assertSame($created->id, $found->id);
        $this->assertSame($endpoint, $found->endpoint);
    }

    public function test_keys_are_encrypted_in_the_database_and_plain_on_the_model(): void
    {
        $subscription = PushSubscription::factory()->create(['p256dh' => 'plain-p256dh-value', 'auth' => 'plain-auth-value']);

        $raw = DB::table('push_subscriptions')->where('id', $subscription->id)->first();

        $this->assertStringNotContainsString('plain-p256dh-value', (string) $raw->p256dh);
        $this->assertStringNotContainsString('plain-auth-value', (string) $raw->auth);
        $this->assertSame('plain-p256dh-value', $subscription->fresh()->p256dh);
        $this->assertSame('plain-auth-value', $subscription->fresh()->auth);
    }

    public function test_public_ids_are_ulids(): void
    {
        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', PushSubscription::factory()->create()->ulid);
        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', DeviceToken::factory()->create()->ulid);
    }

    public function test_one_settings_row_per_user_with_the_documented_defaults(): void
    {
        $user = User::factory()->agent()->create();
        $row = NotificationSetting::query()->create(['user_id' => $user->id])->refresh();

        $this->assertTrue($row->sound);
        $this->assertTrue($row->push_offers);
        $this->assertTrue($row->push_messages);
        $this->assertTrue($row->include_preview);
        $this->assertNull($row->quiet_hours);
        $this->assertSame(PromptState::Never, $row->prompt_state);
        $this->assertNull($row->prompted_at);
        $this->assertNull($row->snoozed_until);

        $this->expectException(QueryException::class);
        NotificationSetting::query()->create(['user_id' => $user->id]);
    }

    public function test_quiet_hours_round_trip_as_json(): void
    {
        $row = NotificationSetting::factory()->quietHours(['timezone' => 'Asia/Riyadh'])->create();

        $this->assertSame(['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'Asia/Riyadh'], $row->fresh()->quiet_hours);
    }

    public function test_a_device_token_is_unique_and_encrypted(): void
    {
        $device = DeviceToken::factory()->create(['token' => 'plain-fcm-token-value-0123456789']);

        $this->assertStringNotContainsString('plain-fcm-token', (string) DB::table('device_tokens')->value('token'));
        $this->assertSame('plain-fcm-token-value-0123456789', $device->fresh()->token);

        $this->expectException(QueryException::class);
        DeviceToken::factory()->create(['token_hash' => $device->token_hash]);
    }

    public function test_deleting_a_user_removes_their_push_data(): void
    {
        $user = User::factory()->agent()->create();
        PushSubscription::factory()->create(['user_id' => $user->id]);
        DeviceToken::factory()->create(['user_id' => $user->id]);
        NotificationSetting::factory()->create(['user_id' => $user->id]);

        $user->delete();

        $this->assertSame(0, PushSubscription::query()->count());
        $this->assertSame(0, DeviceToken::query()->count());
        $this->assertSame(0, NotificationSetting::query()->count());
    }
}
