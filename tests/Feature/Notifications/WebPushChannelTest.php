<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Channels\WebPushChannel;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Tests\Support\InteractsWithWebPush;
use Tests\TestCase;

/** The Web Push channel against a fake push service: headers, encryption, and what each answer does to the subscription. */
class WebPushChannelTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useVapid();
        $this->agent = User::factory()->agent()->create();
    }

    private function offer(string $tag = 'offer-01JTAG', int $ttl = 90): PushMessage
    {
        return new PushMessage(PushType::Offer, $tag, 'New chat request', 'Billing - Hello', '/inbox/01JTAG', $ttl, 'high', false, true);
    }

    private function channel(): WebPushChannel
    {
        return $this->app->make(WebPushChannel::class);
    }

    public function test_it_posts_one_encrypted_vapid_signed_request_per_subscription(): void
    {
        $this->fakePushService();
        $first = $this->subscribe($this->agent);
        $second = $this->subscribe($this->agent);
        $this->subscribe(User::factory()->agent()->create());

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(2, $result->sent);
        $this->assertSame(0, $result->failed + $result->pruned + count($result->retry));
        $requests = $this->pushRequests();
        $this->assertCount(2, $requests);
        $this->assertEqualsCanonicalizing([$first->endpoint, $second->endpoint], array_map(fn ($request): string => $request->url(), $requests));

        $request = $requests[0];
        $this->assertSame('POST', $request->method());
        $this->assertSame(['aes128gcm'], $request->header('Content-Encoding'));
        $this->assertSame(['90'], $request->header('TTL'));
        $this->assertSame(['high'], $request->header('Urgency'));
        $this->assertSame([$this->offer()->topic()], $request->header('Topic'));
        $this->assertStringStartsWith('vapid t=', $request->header('Authorization')[0]);
        $this->assertStringContainsString(', k='.$this->vapidPublicKey, $request->header('Authorization')[0]);
        // The body is the encrypted record: not the readable payload.
        $this->assertStringNotContainsString('New chat request', $request->body());
        $this->assertGreaterThan(100, strlen($request->body()));
        $this->assertNotNull($first->fresh()->last_used_at);
    }

    public function test_the_dismiss_goes_out_with_the_same_topic_and_a_short_ttl(): void
    {
        $this->fakePushService();
        $this->subscribe($this->agent);

        $this->channel()->deliver($this->agent->id, PushMessage::dismiss('offer-01JTAG', 45));

        $request = $this->pushRequests()[0];
        $this->assertSame(['45'], $request->header('TTL'));
        $this->assertSame([$this->offer()->topic()], $request->header('Topic'));
    }

    public function test_a_gone_subscription_is_deleted(): void
    {
        foreach ([404, 410] as $status) {
            $this->fakePushService($status);
            $dead = $this->subscribe($this->agent);

            $result = $this->channel()->deliver($this->agent->id, $this->offer());

            $this->assertSame(1, $result->pruned, (string) $status);
            $this->assertNull(PushSubscription::query()->find($dead->id), (string) $status);
        }
    }

    public function test_a_dead_subscription_does_not_stop_the_healthy_ones(): void
    {
        $dead = $this->subscribe($this->agent);
        $alive = $this->subscribe($this->agent);
        Http::fake([
            $dead->endpoint => Http::response('', 410),
            $alive->endpoint => Http::response('', 201),
        ]);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(1, $result->sent);
        $this->assertSame(1, $result->pruned);
        $this->assertNull(PushSubscription::query()->find($dead->id));
        $this->assertNotNull(PushSubscription::query()->find($alive->id));
        $this->assertNotNull($alive->fresh()->last_used_at);
    }

    public function test_a_push_service_error_is_a_retry_and_keeps_the_subscription(): void
    {
        foreach ([500, 502, 503, 429] as $status) {
            $this->fakePushService($status);
            $subscription = $this->subscribe($this->agent);

            $result = $this->channel()->deliver($this->agent->id, $this->offer());

            $this->assertSame([$subscription->id], $result->retry, (string) $status);
            $this->assertSame(0, $result->sent, (string) $status);
            $this->assertNotNull(PushSubscription::query()->find($subscription->id), (string) $status);
            $this->assertNull($subscription->fresh()->last_used_at);
            $subscription->delete();
        }
    }

    public function test_a_push_service_that_cannot_be_reached_is_a_retry_not_an_exception(): void
    {
        Http::fake(Http::failedConnection('cURL error 28: Operation timed out after 10001 milliseconds'));
        $subscription = $this->subscribe($this->agent);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame([$subscription->id], $result->retry);
    }

    public function test_a_permanent_refusal_is_failed_logged_without_the_endpoint_and_not_retried(): void
    {
        Log::spy();
        $this->fakePushService(403);
        $subscription = $this->subscribe($this->agent);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(1, $result->failed);
        $this->assertSame([], $result->retry);
        $this->assertNotNull(PushSubscription::query()->find($subscription->id));
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message, array $context): bool => $message === 'push.web.refused'
            && $context['status'] === 403
            && ! str_contains((string) json_encode($context), 'fcm.googleapis.com'));
    }

    public function test_a_retry_can_be_limited_to_the_failed_subscriptions(): void
    {
        $this->fakePushService();
        $first = $this->subscribe($this->agent);
        $this->subscribe($this->agent);

        $result = $this->channel()->deliver($this->agent->id, $this->offer(), [$first->id]);

        $this->assertSame(1, $result->sent);
        $this->assertCount(1, $this->pushRequests());
        $this->assertSame($first->endpoint, $this->pushRequests()[0]->url());
    }

    public function test_it_is_off_without_the_vapid_keys_and_sends_nothing(): void
    {
        $this->withoutVapid();
        $this->subscribe($this->agent);

        $this->assertFalse($this->channel()->isEnabled());
        $this->assertTrue($this->channel()->deliver($this->agent->id, $this->offer())->disabled);
        Http::assertNothingSent();
    }

    public function test_it_never_throws_when_the_http_layer_blows_up(): void
    {
        Log::spy();
        // No fake for this host: `Http::preventStrayRequests()` makes the client throw a RuntimeException.
        $this->subscribe($this->agent);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(1, $result->failed);
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message): bool => $message === 'push.web.failed');
    }

    public function test_bad_vapid_keys_fail_quietly(): void
    {
        config(['push.vapid.private_key' => 'not-a-key']);
        $this->subscribe($this->agent);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(1, $result->failed);
        Http::assertNothingSent();
    }

    public function test_an_endpoint_that_is_not_a_public_host_is_never_posted_to(): void
    {
        Http::fake();
        $this->subscribe($this->agent, ['endpoint' => 'https://169.254.169.254/latest/meta-data', 'endpoint_hash' => PushSubscription::hashEndpoint('https://169.254.169.254/latest/meta-data')]);
        $this->subscribe($this->agent, ['endpoint' => 'https://10.0.0.5/push/abc', 'endpoint_hash' => PushSubscription::hashEndpoint('https://10.0.0.5/push/abc')]);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(2, $result->failed);
        Http::assertNothingSent();
    }

    public function test_redirects_are_not_followed(): void
    {
        $subscription = $this->subscribe($this->agent);
        Http::fake([
            $subscription->endpoint => Http::response('', 302, ['Location' => 'http://169.254.169.254/latest/meta-data']),
        ]);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        // The 302 itself is the answer (a refusal, not a delivery); nothing was requested at the Location.
        $this->assertSame(1, $result->failed);
        $this->assertSame(0, $result->sent);
        Http::assertSentCount(1);
    }

    public function test_a_subscription_whose_keys_cannot_be_decrypted_is_dropped(): void
    {
        $this->fakePushService();
        $subscription = $this->subscribe($this->agent);
        PushSubscription::query()->whereKey($subscription->id)->toBase()->update(['p256dh' => 'garbage-not-encrypted']);

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(0, $result->sent);
        $this->assertNull(PushSubscription::query()->find($subscription->id));
    }

    public function test_a_user_without_subscriptions_costs_no_request(): void
    {
        Http::fake();

        $result = $this->channel()->deliver($this->agent->id, $this->offer());

        $this->assertSame(0, $result->attempted());
        Http::assertNothingSent();
    }
}
