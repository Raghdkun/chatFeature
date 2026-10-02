<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Contracts\PushChannel;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Contracts\Bus\Dispatcher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Http;
use Mockery\MockInterface;
use RuntimeException;
use Tests\Support\InteractsWithWebPush;
use Tests\TestCase;

/** The dispatcher and the queued job: queueing, TTL, bounded retries of only what failed, and never throwing. */
class PushDispatcherTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useVapid();
        // The retry tests need a queue that can delay a job (on `sync` no retry is scheduled, see test_nothing_is_retried_on_the_sync_queue).
        config(['queue.default' => 'database']);
        $this->agent = User::factory()->agent()->create();
    }

    private function message(int $ttl = 90): PushMessage
    {
        return new PushMessage(PushType::Offer, 'offer-01JTAG', 'New chat request', 'Billing', '/inbox/01JTAG', $ttl, 'high');
    }

    /** A message push (not an offer: an offer is dropped when its chat is not waiting any more, which these tests do not set up). */
    private function job(?array $targets = null, int $attempt = 1, ?int $queuedAt = null, int $ttl = 90): SendPushToUser
    {
        $message = new PushMessage(PushType::Message, 'chat-01JTAG', 'New message', 'Hello', '/inbox/01JTAG', $ttl, 'normal');

        return new SendPushToUser($this->agent->id, $message->toArray(), $queuedAt ?? now()->getTimestamp(), $targets, $attempt);
    }

    public function test_it_queues_one_job_per_user_with_the_message_and_the_time_it_was_queued(): void
    {
        Bus::fake([SendPushToUser::class]);
        $other = User::factory()->agent()->create();

        $queued = app(PushDispatcher::class)->queue([$this->agent->id, $other->id], $this->message());

        $this->assertSame(2, $queued);
        Bus::assertDispatchedTimes(SendPushToUser::class, 2);
        Bus::assertDispatched(SendPushToUser::class, fn (SendPushToUser $job): bool => $job->userId === $this->agent->id
            && $job->message['tag'] === 'offer-01JTAG'
            && $job->queuedAt === now()->getTimestamp()
            && $job->targetIds === null
            && $job->attempt === 1);
    }

    public function test_the_job_goes_to_the_configured_queue(): void
    {
        Bus::fake([SendPushToUser::class]);
        config(['push.queue' => 'push']);

        app(PushDispatcher::class)->queue([$this->agent->id], $this->message());

        Bus::assertDispatched(SendPushToUser::class, fn (SendPushToUser $job): bool => $job->queue === 'push');
    }

    public function test_a_queue_that_is_down_costs_nothing_and_is_reported(): void
    {
        $this->mock(Dispatcher::class, fn (MockInterface $mock) => $mock->shouldReceive('dispatch')->andThrow(new RuntimeException('Redis is down')));

        $queued = app(PushDispatcher::class)->queue([$this->agent->id], $this->message());

        $this->assertSame(0, $queued);
    }

    public function test_the_job_sends_to_every_device_of_the_user(): void
    {
        $this->fakePushService();
        $this->subscribe($this->agent);
        $this->subscribe($this->agent);

        $this->job()->handle(app(PushDispatcher::class));

        $this->assertCount(2, $this->pushRequests());
    }

    public function test_a_push_that_outlived_its_ttl_is_dropped(): void
    {
        Http::fake();
        $this->subscribe($this->agent);

        $this->job(queuedAt: now()->getTimestamp() - 100, ttl: 60)->handle(app(PushDispatcher::class));

        Http::assertNothingSent();
    }

    public function test_only_the_failed_devices_are_retried_after_a_pause(): void
    {
        $first = $this->subscribe($this->agent);
        $second = $this->subscribe($this->agent);
        Http::fake([
            $first->endpoint => Http::response('', 201),
            $second->endpoint => Http::response('', 503),
        ]);
        Bus::fake([SendPushToUser::class]);

        $this->job()->handle(app(PushDispatcher::class));

        Bus::assertDispatchedTimes(SendPushToUser::class, 1);
        Bus::assertDispatched(SendPushToUser::class, fn (SendPushToUser $job): bool => $job->targetIds === [$second->id]
            && $job->attempt === 2
            && $job->delay === 5
            && $job->queuedAt === now()->getTimestamp());
    }

    public function test_the_pause_grows_and_the_retries_stop_after_the_configured_tries(): void
    {
        $this->fakePushService(503);
        $this->subscribe($this->agent);
        Bus::fake([SendPushToUser::class]);

        $this->job(attempt: 2)->handle(app(PushDispatcher::class));
        Bus::assertDispatched(SendPushToUser::class, fn (SendPushToUser $job): bool => $job->attempt === 3 && $job->delay === 30);

        Bus::fake([SendPushToUser::class]);
        $this->job(attempt: 3)->handle(app(PushDispatcher::class));
        Bus::assertNotDispatched(SendPushToUser::class);
    }

    public function test_a_permanent_refusal_is_not_retried(): void
    {
        $this->subscribe($this->agent);
        $this->fakePushService(403);
        Bus::fake([SendPushToUser::class]);

        $this->job()->handle(app(PushDispatcher::class));

        Bus::assertNotDispatched(SendPushToUser::class);
    }

    public function test_a_dead_subscription_is_deleted_and_not_retried(): void
    {
        $dead = $this->subscribe($this->agent);
        $this->fakePushService(410);
        Bus::fake([SendPushToUser::class]);

        $this->job([$dead->id])->handle(app(PushDispatcher::class));

        Bus::assertNotDispatched(SendPushToUser::class);
        $this->assertNull(PushSubscription::query()->find($dead->id));
    }

    public function test_a_retry_never_re_sends_to_a_device_that_already_got_the_message(): void
    {
        $delivered = $this->subscribe($this->agent);
        $failed = $this->subscribe($this->agent);
        Http::fake([$failed->endpoint => Http::response('', 201)]);

        $this->job([$failed->id], attempt: 2)->handle(app(PushDispatcher::class));

        $this->assertCount(1, $this->pushRequests());
        $this->assertSame($failed->endpoint, $this->pushRequests()[0]->url());
        $this->assertNotNull($delivered);
    }

    public function test_the_job_never_throws_even_when_a_channel_blows_up(): void
    {
        $exploding = new class implements PushChannel
        {
            public function name(): string
            {
                return 'boom';
            }

            public function isEnabled(): bool
            {
                return true;
            }

            public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
            {
                throw new RuntimeException('channel exploded');
            }
        };

        $this->job()->handle(new PushDispatcher([$exploding]));

        $this->assertTrue(true);
    }

    public function test_nothing_is_retried_on_the_sync_queue(): void
    {
        config(['queue.default' => 'sync']);
        $this->subscribe($this->agent);
        $this->fakePushService(503);
        Bus::fake([SendPushToUser::class]);

        $this->job()->handle(app(PushDispatcher::class));

        Bus::assertNotDispatched(SendPushToUser::class);
        $this->assertCount(1, $this->pushRequests(), 'one attempt, not a nested loop of retries');
    }

    public function test_the_job_does_not_retry_by_itself_in_the_queue(): void
    {
        $this->assertSame(1, $this->job()->tries);
    }

    public function test_the_dispatcher_sums_what_the_channels_did_and_skips_disabled_ones(): void
    {
        $enabled = new class implements PushChannel
        {
            public int $calls = 0;

            public function name(): string
            {
                return 'a';
            }

            public function isEnabled(): bool
            {
                return true;
            }

            public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
            {
                $this->calls++;

                return new PushResult(sent: 2, failed: 1);
            }
        };
        $disabled = new class implements PushChannel
        {
            public int $calls = 0;

            public function name(): string
            {
                return 'b';
            }

            public function isEnabled(): bool
            {
                return false;
            }

            public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
            {
                $this->calls++;

                return new PushResult(sent: 100);
            }
        };
        $dispatcher = new PushDispatcher([$enabled, $disabled]);

        $result = $dispatcher->now(1, $this->message());

        $this->assertSame(2, $result->sent);
        $this->assertSame(1, $result->failed);
        $this->assertSame(0, $disabled->calls);
        $this->assertTrue($dispatcher->isEnabled());
        $this->assertFalse((new PushDispatcher([$disabled]))->isEnabled());
        $this->assertTrue((new PushDispatcher([$disabled]))->now(1, $this->message())->disabled);
    }
}
