<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Domain\Notifications\Services\PushMessages;
use App\Domain\Notifications\Services\PushRecipients;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\PushSubscription;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use RuntimeException;
use Tests\Support\ChatFixtures;
use Tests\Support\FakeDashboardVisibility;
use Tests\Support\InteractsWithWebPush;
use Tests\TestCase;

/**
 * Push is an add-on: whatever goes wrong around it (the push service down, the cache or the queue broken, a bug in a listener) the
 * request that caused the event answers exactly as it would without push. The queue runs inline (`sync`) here, so the push job runs
 * inside the request.
 */
class PushFailureIsolationTest extends TestCase
{
    use ChatFixtures, InteractsWithWebPush, RefreshDatabase;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useVapid();
        $this->app->instance(DashboardVisibility::class, new FakeDashboardVisibility);
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->billing);
        $this->subscribe($this->agent);
    }

    private function startChat(): TestResponse
    {
        return $this->withToken($this->visitorSession($this->widget)->plaintext)
            ->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann', 'message' => 'Hello']);
    }

    public function test_the_whole_path_works_inline_when_the_push_service_answers(): void
    {
        $this->fakePushService();

        $this->startChat()->assertCreated();

        $this->assertCount(1, $this->pushRequests());
    }

    public function test_a_push_service_that_is_down_does_not_fail_the_request_and_nothing_retries_in_a_loop_on_the_sync_queue(): void
    {
        $attempts = 0;
        Http::fake(function (Request $request) use (&$attempts) {
            $attempts++;

            return Http::failedConnection('cURL error 28: Operation timed out')($request);
        });

        $this->startChat()->assertCreated();

        // The sync queue runs a delayed retry at once (the pause is ignored), so nothing is retried there: one try, and the request is fine.
        $this->assertSame(1, $attempts);
        $this->assertSame(1, PushSubscription::query()->count());
    }

    public function test_a_push_service_answering_500_does_not_fail_the_request(): void
    {
        $this->fakePushService(500);

        $this->startChat()->assertCreated();
    }

    public function test_a_broken_cache_does_not_fail_the_request(): void
    {
        $this->fakePushService();
        $broken = $this->createStub(Repository::class);
        $broken->method('put')->willThrowException(new RuntimeException('cache down'));
        $broken->method('pull')->willThrowException(new RuntimeException('cache down'));
        $broken->method('add')->willThrowException(new RuntimeException('cache down'));
        $this->app->instance(PushLedger::class, new PushLedger($broken));

        $this->startChat()->assertCreated();
    }

    public function test_a_failing_dispatcher_does_not_fail_the_request(): void
    {
        $this->app->instance(PushDispatcher::class, new class([]) extends PushDispatcher
        {
            public function isEnabled(): bool
            {
                return true;
            }

            public function queue(iterable $userIds, PushMessage $message): int
            {
                throw new RuntimeException('queue down');
            }
        });

        $this->startChat()->assertCreated();
    }

    public function test_a_bug_in_the_recipient_logic_does_not_fail_the_request(): void
    {
        $this->app->bind(PushRecipients::class, fn () => new class extends PushRecipients
        {
            public function __construct() {}

            public function eligible(array $userIds, PushType $type): array
            {
                throw new RuntimeException('bug');
            }
        });

        $this->startChat()->assertCreated();
    }

    public function test_a_bug_while_building_the_message_does_not_fail_the_claim_or_the_message_requests(): void
    {
        $this->app->bind(PushMessages::class, fn () => new class extends PushMessages
        {
            public function offer(Conversation $conversation, User $recipient, bool $includePreview, CarbonInterface $expiresAt): PushMessage
            {
                throw new RuntimeException('bug');
            }

            public function visitorMessage(Conversation $conversation, Message $message, User $recipient, bool $includePreview): PushMessage
            {
                throw new RuntimeException('bug');
            }
        });

        $this->startChat()->assertCreated();
        $chat = Conversation::query()->latest('id')->firstOrFail();

        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/claim')->assertOk();
    }

    public function test_the_visitor_and_agent_messaging_paths_survive_a_broken_push_too(): void
    {
        Http::fake(Http::failedConnection());
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->agent);

        $this->withToken($token->plaintext)
            ->postJson('/api/v1/public/conversations/'.$chat->ulid.'/messages', ['body' => 'Anybody?', 'client_msg_id' => (string) Str::ulid()])
            ->assertSuccessful();
        $this->actingAs($this->agent, 'sanctum')
            ->postJson('/api/v1/conversations/'.$chat->ulid.'/receipts', ['seen_upto' => 1])
            ->assertSuccessful();
    }
}
