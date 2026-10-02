<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Channels\FcmChannel;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\DeviceToken;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use PDOException;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `POST/DELETE /api/v1/me/devices` and the FCM stub behind them (decisions P5-D4, P5-D9). */
class PushDeviceApiTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private const URL = '/api/v1/me/devices';

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->agent = User::factory()->agent()->create();
    }

    public function test_a_device_registers_and_the_token_is_never_returned_or_stored_readable(): void
    {
        $token = Str::random(160);

        $response = $this->actingAs($this->agent, 'sanctum')->postJson(self::URL, ['platform' => 'android', 'token' => $token])
            ->assertCreated()
            ->assertJsonPath('data.platform', 'android');

        $this->assertStringNotContainsString($token, (string) $response->getContent());
        $this->assertNotSame($token, DB::table('device_tokens')->value('token'));
        $this->assertSame($token, DeviceToken::query()->sole()->token);
    }

    public function test_a_deadlock_victim_registering_for_the_first_time_runs_again(): void
    {
        $thrown = 0;

        DB::beforeExecuting(function (string $query) use (&$thrown): void {
            if ($thrown < 2 && str_starts_with($query, 'insert into "device_tokens"')) {
                $thrown++;

                $previous = new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction');
                $previous->errorInfo = ['40001', 1213, 'Deadlock found when trying to get lock; try restarting transaction'];

                $exception = new QueryException('mysql', $query, [], $previous);
                $exception->errorInfo = $previous->errorInfo;

                throw $exception;
            }
        });

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL, ['platform' => 'android', 'token' => Str::random(160)])->assertCreated();

        $this->assertSame(2, $thrown);
        $this->assertSame(1, DeviceToken::query()->count());
    }

    public function test_registering_the_same_token_again_is_an_update_and_a_new_owner_takes_the_device(): void
    {
        $token = Str::random(160);
        $first = $this->actingAs($this->agent, 'sanctum')->postJson(self::URL, ['platform' => 'ios', 'token' => $token])->assertCreated()->json('data.id');

        $colleague = User::factory()->agent()->create();
        $second = $this->actingAs($colleague, 'sanctum')->postJson(self::URL, ['platform' => 'ios', 'token' => $token])->assertOk()->json('data.id');

        $this->assertSame($first, $second);
        $this->assertSame(1, DeviceToken::query()->count());
        $this->assertSame($colleague->id, DeviceToken::query()->sole()->user_id);
    }

    public function test_the_body_is_validated(): void
    {
        foreach ([['platform' => 'windows-phone', 'token' => Str::random(60)], ['platform' => 'android', 'token' => 'short'], ['platform' => 'android'], ['token' => Str::random(60)]] as $body) {
            $this->actingAs($this->agent, 'sanctum')->postJson(self::URL, $body)->assertStatus(422);
        }
    }

    public function test_a_user_removes_their_own_device_and_nobody_elses(): void
    {
        $mine = DeviceToken::factory()->create(['user_id' => $this->agent->id]);
        $theirs = DeviceToken::factory()->create(['user_id' => User::factory()->agent()->create()->id]);

        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.$theirs->ulid)->assertNotFound()->assertJsonPath('error.code', 'device_not_found');
        $this->assertNotNull(DeviceToken::query()->find($theirs->id));

        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.$mine->ulid)->assertNoContent();
        $this->assertNull(DeviceToken::query()->find($mine->id));
    }

    public function test_a_user_keeps_a_bounded_number_of_devices(): void
    {
        config(['push.max_devices_per_user' => 2]);
        $old = DeviceToken::factory()->create(['user_id' => $this->agent->id, 'last_seen_at' => now()->subDays(5)]);
        DeviceToken::factory()->create(['user_id' => $this->agent->id, 'last_seen_at' => now()->subDay()]);

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL, ['platform' => 'android', 'token' => Str::random(100)])->assertCreated();

        $this->assertSame(2, DeviceToken::query()->count());
        $this->assertNull(DeviceToken::query()->find($old->id));
    }

    public function test_guests_and_users_without_chat_access_are_turned_away(): void
    {
        $this->postJson(self::URL, ['platform' => 'android', 'token' => Str::random(60)])->assertUnauthorized();
        $nobody = User::factory()->create(['is_admin' => false, 'is_agent' => false]);
        $this->actingAs($nobody, 'sanctum')->postJson(self::URL, ['platform' => 'android', 'token' => Str::random(60)])->assertForbidden();
    }

    public function test_the_fcm_stub_is_off_by_default_and_touches_no_network(): void
    {
        Http::fake();
        $channel = app(FcmChannel::class);
        DeviceToken::factory()->create(['user_id' => $this->agent->id]);

        $this->assertFalse($channel->isEnabled());
        $this->assertTrue($channel->deliver($this->agent->id, PushMessage::dismiss('offer-x'))->disabled);
        Http::assertNothingSent();
    }

    public function test_the_fcm_stub_only_logs_when_switched_on_and_never_logs_a_token(): void
    {
        Log::spy();
        Http::fake();
        config(['push.fcm.enabled' => true]);
        $device = DeviceToken::factory()->create(['user_id' => $this->agent->id]);
        $channel = app(FcmChannel::class);

        $result = $channel->deliver($this->agent->id, PushMessage::dismiss('offer-x'));

        $this->assertTrue($result->disabled);
        $this->assertSame(0, $result->sent);
        Http::assertNothingSent();
        Log::shouldHaveReceived('info')->withArgs(fn (string $message, array $context): bool => $message === 'push.fcm.stub'
            && $context['devices'] === 1
            && ! str_contains((string) json_encode($context), $device->token));
    }
}
