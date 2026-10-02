<?php

namespace Tests\Feature\Notifications;

use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Auth\Events\Logout;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PDOException;
use Tests\Support\InteractsWithWebPush;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `/api/v1/me/push-subscriptions`: registering, listing and removing the caller's own browsers (decision P5-D9). */
class PushSubscriptionApiTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase, WidgetFixtures;

    private const URL = '/api/v1/me/push-subscriptions';

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useVapid();
        $this->agent = User::factory()->agent()->create();
    }

    /**
     * What `PushSubscription.toJSON()` gives.
     *
     * @return array<string, mixed>
     */
    private function browserSubscription(?string $endpoint = null): array
    {
        return [
            'endpoint' => $endpoint ?? 'https://fcm.googleapis.com/fcm/send/'.Str::random(120),
            'expirationTime' => null,
            'keys' => $this->pushKeys(),
        ];
    }

    private function register(array $body, ?User $as = null, array $headers = []): TestResponse
    {
        return $this->actingAs($as ?? $this->agent, 'sanctum')->withHeaders($headers)->postJson(self::URL, $body);
    }

    public function test_a_browser_registers_and_the_endpoint_and_keys_are_never_returned(): void
    {
        $body = $this->browserSubscription();

        $response = $this->register($body, headers: ['User-Agent' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'])
            ->assertCreated()
            ->assertJsonPath('data.label', 'Chrome on macOS')
            ->assertJsonPath('data.host', 'fcm.googleapis.com')
            ->assertJsonPath('data.endpointHash', hash('sha256', $body['endpoint']))
            ->assertJsonPath('data.lastUsedAt', null);

        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', (string) $response->json('data.id'));
        $raw = $response->getContent();
        $this->assertStringNotContainsString($body['endpoint'], (string) $raw);
        $this->assertStringNotContainsString($body['keys']['p256dh'], (string) $raw);
        $this->assertStringNotContainsString($body['keys']['auth'], (string) $raw);
        $this->assertArrayNotHasKey('id', array_filter($response->json('data'), fn ($v, $k) => $k === 'id' && is_int($v), ARRAY_FILTER_USE_BOTH));

        $row = PushSubscription::query()->sole();
        $this->assertSame($this->agent->id, $row->user_id);
        $this->assertSame($body['endpoint'], $row->endpoint);
        $this->assertSame($body['keys']['p256dh'], $row->p256dh);
    }

    public function test_a_deadlock_victim_registering_for_the_first_time_runs_again_instead_of_answering_500(): void
    {
        $thrown = 0;

        // Two browsers registering at once lock the same gap of the unique `endpoint_hash` index and one INSERT is chosen as the
        // deadlock victim (MySQL 1213, found by the e2e suite): the registration must run again, not become a 500.
        DB::beforeExecuting(function (string $query) use (&$thrown): void {
            if ($thrown < 2 && str_starts_with($query, 'insert into "push_subscriptions"')) {
                $thrown++;

                $previous = new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction');
                $previous->errorInfo = ['40001', 1213, 'Deadlock found when trying to get lock; try restarting transaction'];

                $exception = new QueryException('mysql', $query, [], $previous);
                $exception->errorInfo = $previous->errorInfo;

                throw $exception;
            }
        });

        $this->register($this->browserSubscription())->assertCreated();

        $this->assertSame(2, $thrown);
        $this->assertSame(1, PushSubscription::query()->count());
    }

    public function test_the_keys_are_encrypted_at_rest(): void
    {
        $body = $this->browserSubscription();
        $this->register($body)->assertCreated();

        $raw = DB::table('push_subscriptions')->first();

        $this->assertNotSame($body['keys']['p256dh'], $raw->p256dh);
        $this->assertNotSame($body['keys']['auth'], $raw->auth);
        $this->assertStringNotContainsString($body['keys']['auth'], (string) $raw->auth);
    }

    public function test_registering_the_same_browser_again_updates_it_instead_of_adding_a_row(): void
    {
        $body = $this->browserSubscription();
        $first = $this->register($body)->assertCreated()->json('data.id');

        $body['keys'] = $this->pushKeys();
        $second = $this->register($body)->assertOk()->json('data.id');

        $this->assertSame($first, $second);
        $this->assertSame(1, PushSubscription::query()->count());
        $this->assertSame($body['keys']['auth'], PushSubscription::query()->sole()->auth);
    }

    public function test_a_browser_another_member_of_staff_signs_in_to_is_handed_over(): void
    {
        $body = $this->browserSubscription();
        $this->register($body)->assertCreated();
        $colleague = User::factory()->agent()->create();

        $this->register($body, $colleague)->assertOk();

        $this->assertSame(1, PushSubscription::query()->count());
        $this->assertSame($colleague->id, PushSubscription::query()->sole()->user_id);
        $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)->assertJsonCount(0, 'data');
    }

    public function test_the_expiry_the_browser_reports_is_kept(): void
    {
        $body = $this->browserSubscription();
        $body['expirationTime'] = 1893456000000; // 2030-01-01T00:00:00Z

        $this->register($body)->assertCreated()->assertJsonPath('data.expiresAt', '2030-01-01T00:00:00.000Z');
    }

    public function test_the_list_holds_only_the_callers_browsers_newest_first(): void
    {
        $other = User::factory()->agent()->create();
        $this->subscribe($other);
        $older = $this->subscribe($this->agent, ['created_at' => now()->subDay()]);
        $newer = $this->subscribe($this->agent);

        $response = $this->actingAs($this->agent, 'sanctum')->getJson(self::URL)->assertOk();

        $this->assertSame([$newer->ulid, $older->ulid], array_column($response->json('data'), 'id'));
        $this->assertNull($response->json('meta.next_cursor'));
    }

    public function test_a_user_removes_their_own_browser(): void
    {
        $subscription = $this->subscribe($this->agent);

        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.$subscription->ulid)->assertNoContent();

        $this->assertSame(0, PushSubscription::query()->count());
    }

    public function test_somebody_elses_subscription_is_a_404_and_stays(): void
    {
        $victim = User::factory()->agent()->create();
        $theirs = $this->subscribe($victim);

        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.$theirs->ulid)
            ->assertNotFound()
            ->assertJsonPath('error.code', 'subscription_not_found');
        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.Str::ulid())->assertNotFound();

        $this->assertNotNull(PushSubscription::query()->find($theirs->id));
    }

    public function test_an_integer_id_is_not_a_valid_subscription_id(): void
    {
        $subscription = $this->subscribe($this->agent);

        $this->actingAs($this->agent, 'sanctum')->deleteJson(self::URL.'/'.$subscription->id)->assertNotFound();
        $this->assertSame(1, PushSubscription::query()->count());
    }

    public function test_an_oversized_or_malformed_body_is_refused(): void
    {
        $good = $this->browserSubscription();

        foreach ([
            'endpoint' => ['endpoint' => ''],
            'endpoint (not a url)' => ['endpoint' => 'not a url'],
            'endpoint (http)' => ['endpoint' => 'http://fcm.googleapis.com/fcm/send/abc'],
            'endpoint (too long)' => ['endpoint' => 'https://fcm.googleapis.com/'.str_repeat('a', 2100)],
            'keys.p256dh (short)' => ['keys' => ['p256dh' => 'abc', 'auth' => $good['keys']['auth']]],
            'keys.p256dh (not a point)' => ['keys' => ['p256dh' => rtrim(strtr(base64_encode(str_repeat("\x01", 65)), '+/', '-_'), '='), 'auth' => $good['keys']['auth']]],
            'keys.auth (long)' => ['keys' => ['p256dh' => $good['keys']['p256dh'], 'auth' => rtrim(strtr(base64_encode(random_bytes(40)), '+/', '-_'), '=')]],
            'keys.auth (not base64url)' => ['keys' => ['p256dh' => $good['keys']['p256dh'], 'auth' => 'not base64!!!!!!!!!!!!']],
            'keys (missing)' => ['keys' => null],
            'expirationTime' => ['expirationTime' => 'soon'],
            'content_encoding' => ['content_encoding' => 'rot13'],
        ] as $label => $override) {
            $this->register(array_merge($good, $override))->assertStatus(422, $label);
        }

        $this->assertSame(0, PushSubscription::query()->count());
    }

    public function test_an_endpoint_that_would_make_the_server_call_an_internal_address_is_refused(): void
    {
        foreach ([
            'https://127.0.0.1/push',
            'https://10.0.0.8/push',
            'https://192.168.1.4/push/abc',
            'https://169.254.169.254/latest/meta-data/',
            'https://[::1]/push',
            'https://localhost/push',
            'https://metadata.google.internal/computeMetadata/v1/',
            'https://user:pass@fcm.googleapis.com/fcm/send/abc',
            'ftp://fcm.googleapis.com/fcm/send/abc',
            'file:///etc/passwd',
            'javascript:alert(1)',
        ] as $endpoint) {
            $this->register($this->browserSubscription($endpoint))->assertStatus(422, $endpoint);
        }

        $this->assertSame(0, PushSubscription::query()->count());
    }

    public function test_the_real_push_services_pass(): void
    {
        foreach ([
            'https://fcm.googleapis.com/fcm/send/'.Str::random(100),
            'https://updates.push.services.mozilla.com/wpush/v2/'.Str::random(100),
            'https://web.push.apple.com/'.Str::random(100),
            'https://wns2-par02p.notify.windows.com/w/?token='.Str::random(100),
        ] as $endpoint) {
            $this->register($this->browserSubscription($endpoint))->assertCreated();
        }

        $this->assertSame(4, PushSubscription::query()->count());
    }

    public function test_a_user_keeps_a_bounded_number_of_browsers_the_least_recently_used_go_first(): void
    {
        config(['push.max_subscriptions_per_user' => 3]);
        $oldest = $this->subscribe($this->agent, ['created_at' => now()->subDays(3)]);
        $this->subscribe($this->agent, ['created_at' => now()->subDays(2)]);
        $this->subscribe($this->agent, ['created_at' => now()->subDays(1)]);

        $new = $this->register($this->browserSubscription())->assertCreated()->json('data.id');

        $this->assertSame(3, PushSubscription::query()->count());
        $this->assertNull(PushSubscription::query()->find($oldest->id));
        $this->assertNotNull(PushSubscription::query()->where('ulid', $new)->first());
    }

    public function test_without_vapid_keys_registering_is_refused_with_a_clear_code(): void
    {
        $this->withoutVapid();

        $this->register($this->browserSubscription())
            ->assertStatus(503)
            ->assertJsonPath('error.code', 'push_unavailable');
        $this->assertSame(0, PushSubscription::query()->count());
    }

    public function test_guests_and_users_without_chat_access_are_turned_away(): void
    {
        $subscription = $this->subscribe($this->agent);

        $this->getJson(self::URL)->assertUnauthorized();
        $this->postJson(self::URL, $this->browserSubscription())->assertUnauthorized();
        $this->deleteJson(self::URL.'/'.$subscription->ulid)->assertUnauthorized();

        $nobody = User::factory()->create(['is_admin' => false, 'is_agent' => false]);
        $this->actingAs($nobody, 'sanctum')->getJson(self::URL)->assertForbidden();
        $this->actingAs($nobody, 'sanctum')->postJson(self::URL, $this->browserSubscription())->assertForbidden();
        $this->assertSame(1, PushSubscription::query()->count());
    }

    public function test_registering_is_rate_limited_per_user(): void
    {
        config(['push.rate_limits.subscriptions_per_minute' => 2]);

        $this->register($this->browserSubscription())->assertCreated();
        $this->register($this->browserSubscription())->assertCreated();
        $this->register($this->browserSubscription())->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        // Another member of staff has their own budget.
        $this->register($this->browserSubscription(), User::factory()->agent()->create())->assertCreated();
    }

    public function test_the_test_push_goes_to_the_callers_own_browsers_only_and_reports_the_outcome(): void
    {
        $this->fakePushService();
        $mine = $this->subscribe($this->agent);
        $this->subscribe(User::factory()->agent()->create());

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')
            ->assertOk()
            ->assertExactJson(['data' => ['devices' => 1, 'sent' => 1, 'failed' => 0, 'removed' => 0]]);

        $this->assertCount(1, $this->pushRequests());
        $this->assertSame($mine->endpoint, $this->pushRequests()[0]->url());
        $this->assertSame(['high'], $this->pushRequests()[0]->header('Urgency'));
    }

    public function test_the_test_push_reports_a_dead_browser_as_removed(): void
    {
        $this->fakePushService(410);
        $this->subscribe($this->agent);

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')
            ->assertOk()->assertJsonPath('data.removed', 1)->assertJsonPath('data.sent', 0);
        $this->assertSame(0, PushSubscription::query()->count());
    }

    public function test_the_test_push_reports_a_push_service_that_is_down_as_failed_and_keeps_the_browser(): void
    {
        $this->fakePushService(503);
        $this->subscribe($this->agent);

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')
            ->assertOk()->assertJsonPath('data.failed', 1)->assertJsonPath('data.sent', 0);
        $this->assertSame(1, PushSubscription::query()->count());
    }

    public function test_the_test_push_needs_a_registered_browser_and_configured_keys(): void
    {
        Http::fake();

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')->assertStatus(409)->assertJsonPath('error.code', 'no_push_devices');

        $this->subscribe($this->agent);
        $this->withoutVapid();
        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')->assertStatus(503)->assertJsonPath('error.code', 'push_unavailable');
        Http::assertNothingSent();
    }

    public function test_the_test_push_is_rate_limited_per_user(): void
    {
        config(['push.rate_limits.test_per_minute' => 2]);
        $this->fakePushService();
        $this->subscribe($this->agent);

        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')->assertOk();
        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')->assertOk();
        $this->actingAs($this->agent, 'sanctum')->postJson(self::URL.'/test')
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After');
        $this->assertCount(2, $this->pushRequests());
    }

    public function test_the_session_that_registered_a_browser_is_remembered_hashed(): void
    {
        $this->withHeaders(['Referer' => 'http://localhost'])->actingAs($this->agent)->postJson(self::URL, $this->browserSubscription())->assertCreated();

        $hash = (string) PushSubscription::query()->sole()->session_hash;

        $this->assertSame(64, strlen($hash));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $hash);
    }

    public function test_signing_out_removes_the_subscriptions_of_that_session_only(): void
    {
        $session = $this->app['session.store'];
        $session->start();
        $here = $this->subscribe($this->agent, ['session_hash' => PushSubscription::hashSession($session->getId())]);
        $otherSession = $this->subscribe($this->agent, ['session_hash' => PushSubscription::hashSession('another-session')]);
        $bearer = $this->subscribe($this->agent, ['session_hash' => null]);
        $colleague = $this->subscribe(User::factory()->agent()->create(), ['session_hash' => PushSubscription::hashSession($session->getId())]);

        event(new Logout('web', $this->agent));

        $this->assertNull(PushSubscription::query()->find($here->id));
        $this->assertNotNull(PushSubscription::query()->find($otherSession->id));
        $this->assertNotNull(PushSubscription::query()->find($bearer->id));
        $this->assertNotNull(PushSubscription::query()->find($colleague->id));
    }
}
