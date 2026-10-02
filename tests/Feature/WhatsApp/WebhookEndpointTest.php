<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Services\WebhookSignature;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * `POST /webhooks/openwa/{session}`: the signature gate (nothing is stored or queued before it passes, every refusal looks the same),
 * the size cap, the idempotency ledger, the hand-off to the queue and the limiter.
 */
class WebhookEndpointTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase;

    private const SECRET = 'a-webhook-secret-of-forty-characters-0001';

    private WhatsAppSession $session;

    protected function setUp(): void
    {
        parent::setUp();

        $this->session = $this->webhookSession(self::SECRET);
    }

    private function assertNothingStored(): void
    {
        $this->assertSame(0, WaWebhookDelivery::query()->count(), 'a refused delivery leaves no ledger row');
        $this->assertSame(0, WaChat::query()->count());
        $this->assertSame(0, WaMessage::query()->count());
    }

    private function assertRefusedAlike(TestResponse $response): void
    {
        $response->assertUnauthorized()->assertExactJson(['error' => ['code' => 'unauthenticated', 'message' => 'Authentication is required.']]);
    }

    // ---- the signature matrix ----------------------------------------------------------------------------------------------

    public function test_a_correctly_signed_delivery_is_accepted_stored_and_processed(): void
    {
        $body = $this->messageReceived();

        $this->deliver($this->session, $body)->assertOk()->assertExactJson(['status' => 'accepted'])->assertHeader('Cache-Control', 'no-store, private');

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame($this->session->id, $delivery->session_id);
        $this->assertSame($body['idempotencyKey'], $delivery->idempotency_key);
        $this->assertSame('message.received', $delivery->event);
        $this->assertSame(WebhookOutcome::Processed, $delivery->outcome, 'the sync queue ran the job');
        $this->assertNotNull($delivery->processed_at);
        $this->assertSame(1, WaMessage::query()->count());
    }

    public function test_the_signature_is_over_the_raw_bytes_not_over_a_re_encoded_body(): void
    {
        // Same JSON value, different bytes (pretty printed, with a unicode escape): signed as sent, so it verifies.
        $raw = $this->rawBody($this->session, $this->messageReceived(['body' => 'Grüße 👋']), JSON_PRETTY_PRINT);

        $this->deliver($this->session, $raw)->assertOk();
        $this->assertSame(1, WaMessage::query()->count());
    }

    public function test_a_tampered_body_is_refused(): void
    {
        $body = $this->messageReceived();
        $signed = WebhookSignature::sign((string) json_encode($body), self::SECRET);
        $body['data']['body'] = 'Please send money';

        $this->assertRefusedAlike($this->deliver($this->session, $body, headers: ['X-OpenWA-Signature' => $signed]));
        $this->assertNothingStored();
    }

    /**
     * @return iterable<string, array{string|false}>
     */
    public static function badSignatureHeaders(): iterable
    {
        yield 'missing' => [false];
        yield 'empty' => [''];
        yield 'no prefix' => [str_repeat('a', 64)];
        yield 'wrong prefix' => ['sha1='.str_repeat('a', 40)];
        yield 'prefix only' => ['sha256='];
        yield 'too short' => ['sha256='.str_repeat('a', 63)];
        yield 'too long' => ['sha256='.str_repeat('a', 65)];
        yield 'not hex' => ['sha256='.str_repeat('z', 64)];
        yield 'all zeros' => ['sha256='.str_repeat('0', 64)];
        yield 'with spaces' => [' sha256='.str_repeat('a', 64)];
    }

    #[DataProvider('badSignatureHeaders')]
    public function test_a_missing_or_malformed_signature_header_is_refused_with_the_same_answer(string|false $header): void
    {
        $this->assertRefusedAlike($this->deliver($this->session, $this->messageReceived(), headers: ['X-OpenWA-Signature' => $header]));
        $this->assertNothingStored();
    }

    public function test_the_hex_must_be_lower_case_as_openwa_writes_it(): void
    {
        $body = $this->messageReceived();
        $raw = $this->rawBody($this->session, $body);
        $upper = 'sha256='.strtoupper(substr(WebhookSignature::sign($raw, self::SECRET), 7));

        $this->assertRefusedAlike($this->deliver($this->session, $raw, headers: ['X-OpenWA-Signature' => $upper]));
        $this->assertNothingStored();

        $this->deliver($this->session, $raw)->assertOk();
    }

    public function test_a_wrong_secret_is_refused(): void
    {
        $this->assertRefusedAlike($this->deliver($this->session, $this->messageReceived(), secret: 'another-secret-another-secret-another'));
        $this->assertNothingStored();
    }

    public function test_the_secret_of_another_session_does_not_open_this_one(): void
    {
        $other = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');

        $this->assertRefusedAlike($this->deliver($this->session, $this->messageReceived(), secret: 'the-other-sessions-secret-of-forty-chars-02'));
        $this->assertNothingStored();

        // ... and it still opens its own.
        $this->deliver($other, $this->messageReceived())->assertOk();
    }

    public function test_a_session_that_never_registered_a_webhook_refuses_everything_even_an_empty_secret_signature(): void
    {
        $unregistered = WhatsAppSession::factory()->create();
        $raw = $this->rawBody($this->session, $this->messageReceived());

        foreach (['', 'x', 'no-webhook-secret-registered'] as $guess) {
            $this->assertRefusedAlike($this->deliver($unregistered, $raw, headers: ['X-OpenWA-Signature' => WebhookSignature::sign($raw, $guess)]));
        }

        $this->assertNothingStored();
    }

    public function test_an_unknown_deleted_or_malformed_session_is_a_404_before_anything_else(): void
    {
        $this->assertRefusedAlike($this->deliver($this->session, $this->messageReceived(), secret: 'nope'));

        $deleted = $this->webhookSession('deleted-session-secret-of-forty-chars-0003');
        $deleted->delete();

        $this->deliver($deleted, $this->messageReceived())->assertNotFound();

        $unknown = new WhatsAppSession(['name' => 'ghost']);
        $unknown->ulid = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
        $this->deliver($unknown, $this->messageReceived(), secret: self::SECRET)->assertNotFound();

        $this->call('POST', '/webhooks/openwa/not-a-ulid', [], [], [], [], '{}')->assertNotFound();
        $this->assertNothingStored();
    }

    public function test_a_valid_signature_replayed_is_a_200_no_op(): void
    {
        $raw = $this->rawBody($this->session, $this->messageReceived());

        $this->deliver($this->session, $raw)->assertOk()->assertExactJson(['status' => 'accepted']);
        $this->deliver($this->session, $raw)->assertOk()->assertExactJson(['status' => 'duplicate']);
        $this->deliver($this->session, $raw, headers: ['X-OpenWA-Delivery-Id' => 'dlv_a-replay-gets-a-new-id'])->assertOk()->assertExactJson(['status' => 'duplicate']);

        $this->assertSame(1, WaWebhookDelivery::query()->count());
        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(1, WaChat::query()->sole()->unread_by_admin);
    }

    public function test_the_key_is_unique_per_session_not_global(): void
    {
        $other = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');
        $body = $this->messageReceived(key: 'same-key-in-two-sessions');

        $this->deliver($this->session, $body)->assertExactJson(['status' => 'accepted']);
        $this->deliver($other, $body)->assertExactJson(['status' => 'accepted']);

        $this->assertSame(2, WaWebhookDelivery::query()->count());
    }

    // ---- size, shape -------------------------------------------------------------------------------------------------------

    public function test_a_body_over_the_cap_is_refused_before_anything_is_stored(): void
    {
        config(['whatsapp.webhook.max_body_bytes' => 4096]);
        $big = $this->messageReceived(['body' => str_repeat('x', 5000)]);

        $this->deliver($this->session, $big)->assertStatus(413)->assertJsonPath('error.code', 'payload_too_large');
        $this->assertNothingStored();

        // Exactly within the cap passes.
        config(['whatsapp.webhook.max_body_bytes' => 65536]);
        $this->deliver($this->session, $big)->assertOk();
    }

    public function test_an_oversized_body_is_refused_even_with_a_forged_content_length(): void
    {
        config(['whatsapp.webhook.max_body_bytes' => 4096]);

        $this->deliver($this->session, $this->messageReceived(['body' => str_repeat('x', 5000)]), headers: ['Content-Length' => '10'])->assertStatus(413);
        $this->assertNothingStored();
    }

    public function test_a_body_that_is_not_json_with_a_valid_signature_is_recorded_as_rejected_and_acknowledged(): void
    {
        Bus::fake();

        $this->deliver($this->session, 'this is not json', headers: ['X-OpenWA-Idempotency-Key' => 'garbage-1'])->assertOk()->assertExactJson(['status' => 'rejected']);

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame(WebhookOutcome::Rejected, $delivery->outcome);
        $this->assertNotNull($delivery->processed_at);
        Bus::assertNotDispatched(ProcessWebhookDelivery::class);
        $this->assertSame(0, WaChat::query()->count());
    }

    public function test_a_json_list_or_scalar_is_rejected_too(): void
    {
        foreach (['[1,2,3]', '"hello"', '42'] as $index => $raw) {
            $this->deliver($this->session, $raw, headers: ['X-OpenWA-Idempotency-Key' => 'odd-'.$index])->assertOk()->assertExactJson(['status' => 'rejected']);
        }

        $this->assertSame(3, WaWebhookDelivery::query()->where('outcome', WebhookOutcome::Rejected->value)->count());
    }

    public function test_the_idempotency_key_falls_back_to_the_body_when_the_header_is_missing(): void
    {
        $body = $this->messageReceived();
        unset($body['idempotencyKey']);
        $raw = $this->rawBody($this->session, $body);

        $this->deliver($this->session, $raw, headers: ['X-OpenWA-Idempotency-Key' => false])->assertExactJson(['status' => 'accepted']);
        $this->deliver($this->session, $raw, headers: ['X-OpenWA-Idempotency-Key' => false])->assertExactJson(['status' => 'duplicate']);

        $this->assertStringStartsWith('body:', WaWebhookDelivery::query()->sole()->idempotency_key);
    }

    public function test_a_very_long_key_is_stored_hashed_and_still_deduplicates(): void
    {
        $key = 'msg_'.str_repeat('a', 400);
        $body = $this->messageReceived(key: $key);

        $this->deliver($this->session, $body)->assertExactJson(['status' => 'accepted']);
        $this->deliver($this->session, $body)->assertExactJson(['status' => 'duplicate']);

        $this->assertSame(WaWebhookDelivery::keyFor($key), WaWebhookDelivery::query()->sole()->idempotency_key);
    }

    // ---- the queue ---------------------------------------------------------------------------------------------------------

    public function test_the_response_does_not_wait_for_the_processing_when_a_queue_is_used(): void
    {
        Queue::fake();

        $this->deliver($this->session, $this->messageReceived())->assertOk()->assertExactJson(['status' => 'accepted']);

        Queue::assertPushed(ProcessWebhookDelivery::class, 1);
        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertNull($delivery->outcome, 'queued, not processed yet');
        $this->assertSame(0, WaMessage::query()->count());
    }

    public function test_when_the_queue_cannot_take_the_job_the_ledger_row_is_removed_and_the_request_fails(): void
    {
        Bus::shouldReceive('dispatch')->andThrow(new \RuntimeException('redis is down'));
        $this->withoutExceptionHandling();

        try {
            $this->deliver($this->session, $this->messageReceived());
            $this->fail('the failure was swallowed');
        } catch (\RuntimeException $exception) {
            $this->assertSame('redis is down', $exception->getMessage());
        }

        $this->assertSame(0, WaWebhookDelivery::query()->count(), 'a delivery nobody owns must not be marked as seen');
    }

    public function test_a_stranded_delivery_is_queued_again_by_openwas_repeat_but_a_fresh_one_is_not(): void
    {
        Queue::fake();
        $body = $this->messageReceived();
        $raw = $this->rawBody($this->session, $body);

        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'accepted']);
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);

        // The repeat comes seconds later: the job is probably still waiting.
        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'duplicate']);
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);

        // Ten minutes on the job is evidently lost (the queue was flushed): the next repeat owns it.
        WaWebhookDelivery::query()->update(['received_at' => now()->subMinutes(10)]);
        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'accepted']);
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);

        // And only one repeat wins that right.
        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'duplicate']);
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
    }

    public function test_a_processed_delivery_is_never_queued_again(): void
    {
        $raw = $this->rawBody($this->session, $this->messageReceived());
        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'accepted']);
        WaWebhookDelivery::query()->update(['received_at' => now()->subDay()]);

        Queue::fake();
        $this->deliver($this->session, $raw)->assertExactJson(['status' => 'duplicate']);
        Queue::assertNothingPushed();
    }

    // ---- the limiter and the logs ------------------------------------------------------------------------------------------

    public function test_a_flood_is_limited_per_client_network_and_signed_requests_count_too(): void
    {
        config(['whatsapp.webhook.rate_limits.per_network' => 3, 'whatsapp.webhook.rate_limits.per_session' => 100]);

        foreach (range(1, 3) as $index) {
            $this->deliver($this->session, $this->messageReceived(), secret: 'wrong-'.$index)->assertUnauthorized();
        }

        $this->deliver($this->session, $this->messageReceived())->assertStatus(429);
    }

    public function test_the_body_the_secret_and_the_signature_are_never_logged(): void
    {
        Log::spy();

        $this->deliver($this->session, $this->messageReceived(['body' => 'top secret customer text']), secret: 'wrong-secret-of-the-attacker-xxxxxxxxxx');
        $this->deliver($this->session, $this->messageReceived(['body' => 'top secret customer text']));

        Log::shouldNotHaveReceived('debug');
        Log::shouldNotHaveReceived('info');
        Log::shouldNotHaveReceived('warning');
        Log::shouldNotHaveReceived('error');
    }

    public function test_the_route_is_outside_the_stateful_stack_no_cookies_no_csrf(): void
    {
        $response = $this->deliver($this->session, $this->messageReceived());

        $response->assertOk();
        $this->assertSame([], $response->headers->getCookies(), 'a webhook answer never sets a cookie');
    }
}
