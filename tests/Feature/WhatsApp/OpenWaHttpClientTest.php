<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaAddressRefused;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaNotConfigured;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRequestNotConfirmed;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Infrastructure\OpenWa\OpenWaEndpoint;
use App\Infrastructure\OpenWa\OpenWaHttpClient;
use App\Support\Network\HostResolver;
use App\Support\Network\OutboundTarget;
use Closure;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Promise\PromiseInterface;
use GuzzleHttp\Psr7\Request as PsrRequest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeHostResolver;
use Tests\Support\OpenWaFixtures;
use Tests\TestCase;

/**
 * The HTTP implementation of the OpenWA client against faked answers shaped like `docs/reference/openwa-api.md`: URLs, the key header,
 * bodies, every error class, the retry rules, response validation, the address guard and the promise that the key goes nowhere but
 * its header. Answers load from `tests/fixtures/openwa/<name>.json` when the ops track has recorded the real ones.
 */
class OpenWaHttpClientTest extends TestCase
{
    use RefreshDatabase;

    private const KEY = 'owa_k1_secret-key-for-tests-0123456789';

    private const SESSION = '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a';

    protected function setUp(): void
    {
        parent::setUp();

        config(['chat.portal_allow_private_hosts' => true]);
        settings()->set('whatsapp.openwa.api_key', self::KEY);
        settings()->set('whatsapp.openwa.base_url', 'http://127.0.0.1:2785');
    }

    private function client(): OpenWaHttpClient
    {
        return $this->app->make(OpenWaHttpClient::class);
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function answer(array $body, int $status = 200): PromiseInterface
    {
        return Http::response($body, $status);
    }

    // ---- the happy path of every call --------------------------------------------------------------------------------------

    public function test_ping_posts_to_validate_with_the_key_header_and_reads_role_and_engine(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::load('ping', ['valid' => true, 'role' => 'operator', 'engineType' => 'whatsapp-web.js']))]);

        $ping = $this->client()->ping();

        $this->assertSame('operator', $ping->role);
        $this->assertSame('whatsapp-web.js', $ping->engine);
        $this->assertTrue($ping->canOperate());
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === 'http://127.0.0.1:2785/api/auth/validate'
            && $request->header('X-API-Key') === [self::KEY]
            && $request->header('Accept') === ['application/json']);
    }

    public function test_create_session_sends_the_name_and_returns_the_session(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::session('created'), 201)]);

        $session = $this->client()->createSession('support-main');

        $this->assertSame(self::SESSION, $session->id);
        $this->assertSame(SessionStatus::Created, $session->status);
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === 'http://127.0.0.1:2785/api/sessions'
            && $request->data() === ['name' => 'support-main']);
    }

    public function test_start_and_stop_post_without_a_body_and_map_the_wire_status(): void
    {
        Http::fake([
            '*/start' => $this->answer(OpenWaFixtures::session('initializing')),
            '*/stop' => $this->answer(OpenWaFixtures::session('disconnected')),
        ]);

        $this->assertSame(SessionStatus::Starting, $this->client()->startSession(self::SESSION)->status);
        $this->assertSame(SessionStatus::Disconnected, $this->client()->stopSession(self::SESSION)->status);

        Http::assertSent(fn (Request $request): bool => $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION.'/start' && $request->body() === '');
        Http::assertSent(fn (Request $request): bool => $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION.'/stop');
    }

    public function test_get_session_reads_phone_push_name_and_connection_time(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::session('ready'))]);

        $session = $this->client()->getSession(self::SESSION);

        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('+6281234567890', $session->phone);
        $this->assertSame('Support', $session->pushName);
        $this->assertTrue($session->engineLoaded);
        Http::assertSent(fn (Request $request): bool => $request->method() === 'GET' && $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION);
    }

    public function test_delete_session_accepts_a_204(): void
    {
        Http::fake(['*' => Http::response('', 204)]);

        $this->client()->deleteSession(self::SESSION);

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE' && $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION);
    }

    public function test_get_qr_returns_the_png_data_url(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::load('qr', ['qrCode' => OpenWaFixtures::PNG_DATA_URL, 'status' => 'qr_ready']))]);

        $qr = $this->client()->getQr(self::SESSION);

        $this->assertSame(OpenWaFixtures::PNG_DATA_URL, $qr->dataUrl);
        $this->assertSame(SessionStatus::Qr, $qr->status);
        Http::assertSent(fn (Request $request): bool => str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/qr'));
    }

    public function test_register_webhook_sends_url_events_and_secret_and_reads_only_the_id_back(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::load('webhook-created', [
            'id' => 'f1e2d3c4-b5a6-7890-1234-567890abcdef', 'sessionId' => 'support-main', 'url' => 'https://chat.example/webhooks/openwa/01J', 'events' => ['message.received'],
            'filters' => null, 'active' => true, 'retryCount' => 3, 'lastTriggeredAt' => null,
        ]), 201)]);

        $webhook = $this->client()->registerWebhook(self::SESSION, 'https://chat.example/webhooks/openwa/01J', 'a-webhook-secret-of-40-characters-0123456789', ['message.received', 'message.ack']);

        $this->assertSame('f1e2d3c4-b5a6-7890-1234-567890abcdef', $webhook->id);
        $this->assertTrue($webhook->active);
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/webhooks')
            && $request->data() === [
                'url' => 'https://chat.example/webhooks/openwa/01J',
                'events' => ['message.received', 'message.ack'],
                'secret' => 'a-webhook-secret-of-40-characters-0123456789',
            ]);
    }

    public function test_delete_webhook_targets_the_webhook_of_the_session(): void
    {
        Http::fake(['*' => Http::response('', 204)]);

        $this->client()->deleteWebhook(self::SESSION, 'hook-1');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'DELETE' && str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/webhooks/hook-1'));
    }

    public function test_send_text_posts_chat_and_text_and_reads_the_message_id_and_epoch_seconds(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::load('send-text', ['messageId' => 'true_628123456789@c.us_3EB0ABCD', 'timestamp' => 1719312000]), 201)]);

        $result = $this->client()->sendText(self::SESSION, '628123456789@c.us', 'Hello from OpenWA!');

        $this->assertSame('true_628123456789@c.us_3EB0ABCD', $result->messageId);
        $this->assertSame(1719312000, $result->timestamp->getTimestamp());
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/messages/send-text')
            && $request->data() === ['chatId' => '628123456789@c.us', 'text' => 'Hello from OpenWA!']);
    }

    public function test_download_media_returns_the_bytes_the_type_and_the_file_name(): void
    {
        Http::fake(['*' => Http::response('IMAGEBYTES', 200, ['Content-Type' => 'image/jpeg; charset=binary', 'Content-Disposition' => 'attachment; filename="photo 1.jpg"'])]);

        $media = $this->client()->downloadMedia(self::SESSION, '628123456789@c.us', 'true_628123456789@c.us_3EB0ABCD');

        $this->assertNotNull($media);
        $this->assertSame('IMAGEBYTES', $media->contents);
        $this->assertSame('image/jpeg', $media->mime);
        $this->assertSame('photo 1.jpg', $media->filename);
        Http::assertSent(fn (Request $request): bool => $request->method() === 'GET'
            && str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/messages/628123456789%40c.us/true_628123456789%40c.us_3EB0ABCD/media'));
    }

    public function test_media_that_is_not_there_is_null_and_an_empty_body_too(): void
    {
        Http::fake(['*/media' => Http::sequence()
            ->push(['statusCode' => 404, 'message' => 'No media stored for this message', 'error' => 'Not Found'], 404)
            ->push('', 200, ['Content-Type' => 'image/png'])]);

        $this->assertNull($this->client()->downloadMedia(self::SESSION, 'c@c.us', 'm1'));
        $this->assertNull($this->client()->downloadMedia(self::SESSION, 'c@c.us', 'm2'));
    }

    public function test_media_above_the_configured_limit_is_refused_not_buffered_forever(): void
    {
        settings()->set('whatsapp.media_max_bytes', 10_240);
        Http::fake(['*' => Http::response(str_repeat('x', 10_241), 200, ['Content-Type' => 'image/jpeg'])]);

        try {
            $this->client()->downloadMedia(self::SESSION, 'c@c.us', 'm1');
            $this->fail('an oversized download was accepted');
        } catch (OpenWaRejected $rejected) {
            $this->assertSame(413, $rejected->status);
            $this->assertSame('payload_too_large', $rejected->errorCode);
        }
    }

    // ---- errors ------------------------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{int, array<string, mixed>, string, bool}>
     */
    public static function rejections(): iterable
    {
        yield '401 key refused' => [401, ['statusCode' => 401, 'message' => 'Invalid API key', 'error' => 'Unauthorized'], 'unauthorized', true];
        yield '403 role too low' => [403, ['statusCode' => 403, 'message' => 'Insufficient permissions. Required: operator', 'error' => 'Forbidden'], 'forbidden', true];
        yield '404 unknown session' => [404, ['statusCode' => 404, 'message' => "Session 'x' not found", 'error' => 'Not Found'], 'not_found', false];
        yield '409 name exists' => [409, ['statusCode' => 409, 'message' => "Session with name 'x' already exists", 'error' => 'Conflict'], 'conflict', false];
        yield '409 teardown pending' => [409, ['statusCode' => 409, 'message' => 'teardown in flight', 'error' => 'Conflict', 'code' => 'SESSION_NAME_TEARDOWN_PENDING'], 'SESSION_NAME_TEARDOWN_PENDING', false];
        yield '400 validation list' => [400, ['statusCode' => 400, 'message' => ['name must be longer than or equal to 3 characters', 'name must match pattern'], 'error' => 'Bad Request'], 'bad_request', false];
        yield '400 production validation' => [400, ['statusCode' => 400, 'message' => 'Bad Request'], 'bad_request', false];
        yield '413 too large' => [413, ['statusCode' => 413, 'message' => 'Payload Too Large'], 'payload_too_large', false];
        yield '429 throttler' => [429, ['statusCode' => 429, 'message' => 'ThrottlerException: Too Many Requests'], 'rate_limited', false];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('rejections')]
    public function test_a_4xx_becomes_a_rejection_with_the_code_of_the_body_or_of_the_status(int $status, array $body, string $code, bool $unauthorized): void
    {
        Http::fake(['*' => $this->answer($body, $status)]);

        try {
            $this->client()->getSession(self::SESSION);
            $this->fail('a refused call was accepted');
        } catch (OpenWaRejected $rejected) {
            $this->assertSame($status, $rejected->status);
            $this->assertSame($code, $rejected->errorCode);
            $this->assertSame($unauthorized, $rejected->isUnauthorized());
            $this->assertNotInstanceOf(OpenWaPacingLimited::class, $rejected);
        }
    }

    public function test_a_validation_error_list_is_joined_into_one_message(): void
    {
        Http::fake(['*' => $this->answer(['statusCode' => 400, 'message' => ['a is wrong', 'b is wrong'], 'error' => 'Bad Request'], 400)]);

        try {
            $this->client()->createSession('x');
            $this->fail('accepted');
        } catch (OpenWaRejected $rejected) {
            $this->assertSame('a is wrong; b is wrong', $rejected->getMessage());
        }
    }

    public function test_the_pacing_limit_carries_the_wait_and_is_not_an_ordinary_throttle(): void
    {
        Http::fake(['*' => $this->answer(OpenWaFixtures::load('error-pacing-limited', [
            'statusCode' => 429, 'error' => 'Too Many Requests', 'message' => 'Daily allowance of 5 new conversation(s) reached', 'code' => 'SEND_PACING_LIMITED', 'retryAfterSeconds' => 34521,
        ]), 429)]);

        try {
            $this->client()->sendText(self::SESSION, '1@c.us', 'hi');
            $this->fail('accepted');
        } catch (OpenWaPacingLimited $limited) {
            $this->assertSame(34521, $limited->retryAfterSeconds);
            $this->assertSame('SEND_PACING_LIMITED', $limited->errorCode);
        }
    }

    public function test_the_pacing_limit_falls_back_to_the_retry_after_header(): void
    {
        Http::fake(['*' => Http::response(['statusCode' => 429, 'code' => 'SEND_PACING_LIMITED', 'message' => 'x'], 429, ['Retry-After' => '90'])]);

        try {
            $this->client()->sendText(self::SESSION, '1@c.us', 'hi');
            $this->fail('accepted');
        } catch (OpenWaPacingLimited $limited) {
            $this->assertSame(90, $limited->retryAfterSeconds);
        }
    }

    /**
     * @return iterable<string, array{int}>
     */
    public static function serverFaults(): iterable
    {
        yield '500' => [500];
        yield '502 bad gateway' => [502];
        yield '503' => [503];
        yield '504 engine did not start' => [504];
        yield '302 redirect is never followed' => [302];
    }

    #[DataProvider('serverFaults')]
    public function test_a_server_fault_or_redirect_is_unavailable_not_rejected(int $status): void
    {
        Http::fake(['*' => Http::response('<html>proxy error</html>', $status, ['Location' => 'http://evil.test/'])]);

        try {
            $this->client()->startSession(self::SESSION);
            $this->fail('accepted');
        } catch (OpenWaRejected) {
            $this->fail('a server fault is not a rejection');
        } catch (OpenWaUnavailable $unavailable) {
            $this->assertStringContainsString((string) $status, $unavailable->getMessage());
        }

        Http::assertSentCount(1);
    }

    // ---- response validation -----------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{Closure(): mixed, mixed}>
     */
    public static function unusableAnswers(): iterable
    {
        yield 'not JSON' => [fn () => Http::response('OK', 200), 'text'];
        yield 'a bare list' => [fn () => Http::response([['id' => 'x']], 200), 'list'];
        yield 'session without id' => [fn () => Http::response(['name' => 'x', 'status' => 'ready'], 200), 'noid'];
    }

    #[DataProvider('unusableAnswers')]
    public function test_an_answer_that_is_not_what_the_api_documents_is_unavailable(Closure $answer): void
    {
        Http::fake(['*' => $answer()]);

        $this->expectException(OpenWaUnavailable::class);

        $this->client()->getSession(self::SESSION);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function badQrCodes(): iterable
    {
        yield 'a remote URL' => ['https://evil.test/qr.png'];
        yield 'an SVG data URL' => ['data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+'];
        yield 'a script' => ['data:text/html;base64,PHNjcmlwdD4='];
        yield 'markup inside the base64 alphabet slot' => ['data:image/png;base64,AAA"><script>alert(1)</script>'];
        yield 'raw linking ref' => ['2@abcdefghijklmnop,qrstuvwx,yz0123456789=='];
        yield 'oversized' => ['data:image/png;base64,'.'A'.'AAA'.str_repeat('AAAA', OpenWaQr::MAX_LENGTH / 4)];
    }

    #[DataProvider('badQrCodes')]
    public function test_a_qr_that_is_not_a_small_base64_png_data_url_is_refused(string $qr): void
    {
        Http::fake(['*' => Http::response(['qrCode' => $qr, 'status' => 'qr_ready'], 200)]);

        $this->expectException(OpenWaUnavailable::class);

        $this->client()->getQr(self::SESSION);
    }

    public function test_a_400_while_the_session_is_not_waiting_for_a_scan_is_a_rejection(): void
    {
        Http::fake(['*' => $this->answer(['statusCode' => 400, 'message' => 'Session is not waiting for a QR scan', 'error' => 'Bad Request'], 400)]);

        try {
            $this->client()->getQr(self::SESSION);
            $this->fail('accepted');
        } catch (OpenWaRejected $rejected) {
            $this->assertSame(400, $rejected->status);
        }
    }

    // ---- retries and transport failures ------------------------------------------------------------------------------------

    public function test_a_get_is_repeated_once_when_the_connection_failed(): void
    {
        Http::fake(['*' => Http::sequence()
            ->pushFailedConnection()
            ->push(OpenWaFixtures::session('ready'), 200)]);

        $this->assertSame(SessionStatus::Ready, $this->client()->getSession(self::SESSION)->status);
        Http::assertSentCount(2);
    }

    public function test_a_get_gives_up_after_one_repeat(): void
    {
        Http::fake(['*' => Http::sequence()->pushFailedConnection()->pushFailedConnection()->push(OpenWaFixtures::session('ready'), 200)]);

        $this->expectException(OpenWaUnavailable::class);

        try {
            $this->client()->getSession(self::SESSION);
        } finally {
            Http::assertSentCount(2);
        }
    }

    public function test_an_http_error_answer_is_never_repeated(): void
    {
        Http::fake(['*' => Http::response('boom', 503)]);

        try {
            $this->client()->getSession(self::SESSION);
        } catch (OpenWaUnavailable) {
        }

        Http::assertSentCount(1);
    }

    public function test_a_write_is_never_repeated_and_one_that_may_have_been_sent_says_so(): void
    {
        Http::fake(['*' => Http::sequence()->pushFailedConnection()->push(['messageId' => 'm', 'timestamp' => 1], 201)]);

        try {
            $this->client()->sendText(self::SESSION, '1@c.us', 'hi');
            $this->fail('accepted');
        } catch (OpenWaRequestNotConfirmed $exception) {
            $this->assertStringContainsString('may or may not', $exception->getMessage());
        }

        Http::assertSentCount(1);
    }

    public function test_a_write_that_certainly_never_connected_is_a_plain_unavailable(): void
    {
        $refused = new ConnectException('cURL error 7: Failed to connect', new PsrRequest('POST', 'http://127.0.0.1:2785'), null, ['errno' => 7]);
        Http::fake(['*' => fn () => throw $refused]);

        try {
            $this->client()->sendText(self::SESSION, '1@c.us', 'hi');
            $this->fail('accepted');
        } catch (OpenWaUnavailable $exception) {
            $this->assertNotInstanceOf(OpenWaRequestNotConfirmed::class, $exception);
            $this->assertSame('OpenWA could not be reached.', $exception->getMessage());
        }

        Http::assertSentCount(1);
    }

    public function test_a_timeout_while_connecting_never_reached_openwa(): void
    {
        $connecting = new ConnectException('cURL error 28: Connection timed out', new PsrRequest('POST', 'http://x'), null, ['errno' => 28, 'connect_time' => 0.0]);
        Http::fake(['*' => fn () => throw $connecting]);

        try {
            $this->client()->createSession('support-main');
            $this->fail('accepted');
        } catch (OpenWaUnavailable $exception) {
            $this->assertNotInstanceOf(OpenWaRequestNotConfirmed::class, $exception);
        }
    }

    public function test_a_timeout_while_waiting_for_the_answer_may_have_been_sent(): void
    {
        $waiting = new ConnectException('cURL error 28: Operation timed out', new PsrRequest('POST', 'http://x'), null, ['errno' => 28, 'connect_time' => 0.002]);
        Http::fake(['*' => fn () => throw $waiting]);

        $this->expectException(OpenWaRequestNotConfirmed::class);

        $this->client()->createSession('support-main');
    }

    // ---- configuration, address guard, the key -----------------------------------------------------------------------------

    public function test_without_an_api_key_nothing_is_sent(): void
    {
        settings()->set('whatsapp.openwa.api_key', null);
        Http::fake();

        $this->expectException(OpenWaNotConfigured::class);

        try {
            $this->client()->ping();
        } finally {
            Http::assertNothingSent();
        }
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function privateAddresses(): iterable
    {
        yield 'a private address' => ['http://10.0.0.5:2785'];
        yield 'loopback' => ['http://127.0.0.1:2785'];
        yield 'a docker service name' => ['http://openwa:2785'];
    }

    #[DataProvider('privateAddresses')]
    public function test_a_saved_private_address_is_not_called_once_private_hosts_are_not_allowed(string $address): void
    {
        // Saved while the switch was on; the switch is off now (or the install moved): the client judges again before every call.
        settings()->set('whatsapp.openwa.base_url', $address);
        config(['chat.portal_allow_private_hosts' => false]);
        Http::fake();

        try {
            $this->client()->ping();
            $this->fail('a refused address was called');
        } catch (OpenWaAddressRefused $refused) {
            $this->assertSame('The configured OpenWA address is not allowed.', $refused->getMessage());
            $this->assertStringNotContainsString($address, $refused->getMessage());
        }

        Http::assertNothingSent();
    }

    public function test_a_name_that_was_re_pointed_at_the_internal_network_is_not_called(): void
    {
        config(['chat.portal_allow_private_hosts' => false]);
        settings()->set('whatsapp.openwa.base_url', 'https://openwa.example.org');
        $this->app->instance(HostResolver::class, new FakeHostResolver(['openwa.example.org' => ['10.0.0.5']]));
        Http::fake();

        $this->expectException(OpenWaAddressRefused::class);

        try {
            $this->client()->ping();
        } finally {
            Http::assertNothingSent();
        }
    }

    public function test_a_public_name_is_called_over_https_and_the_connection_is_pinned_to_the_judged_address(): void
    {
        config(['chat.portal_allow_private_hosts' => false]);
        settings()->set('whatsapp.openwa.base_url', 'https://openwa.example.org');
        Http::fake(['*' => $this->answer(['valid' => true, 'role' => 'admin', 'engineType' => 'baileys'])]);

        $this->client()->ping();

        Http::assertSent(fn (Request $request): bool => $request->url() === 'https://openwa.example.org/api/auth/validate');
    }

    public function test_a_changed_address_applies_to_the_very_next_call(): void
    {
        Http::fake(['*' => $this->answer(['valid' => true, 'role' => 'admin', 'engineType' => 'baileys'])]);

        $this->client()->ping();
        settings()->set('whatsapp.openwa.base_url', 'http://10.1.2.3:2785');
        $this->client()->ping();

        Http::assertSent(fn (Request $request): bool => str_starts_with($request->url(), 'http://10.1.2.3:2785/'));
    }

    public function test_the_key_is_only_ever_in_its_header(): void
    {
        Http::fake(['*' => Http::sequence()
            ->push(['statusCode' => 401, 'message' => 'Invalid API key', 'error' => 'Unauthorized'], 401)
            ->pushFailedConnection()
            ->push('', 500)]);

        $messages = [];

        foreach ([fn () => $this->client()->getSession(self::SESSION), fn () => $this->client()->createSession('abc'), fn () => $this->client()->startSession(self::SESSION)] as $call) {
            try {
                $call();
            } catch (\Throwable $exception) {
                $messages[] = $exception->getMessage().'|'.$exception->getTraceAsString();
            }
        }

        $this->assertCount(3, $messages);
        Http::assertSent(fn (Request $request): bool => ! str_contains($request->url(), self::KEY) && ! str_contains($request->body(), self::KEY));

        foreach ($messages as $message) {
            $this->assertStringNotContainsString(self::KEY, $message);
        }
    }

    public function test_the_endpoint_hides_the_key_from_dumps(): void
    {
        $endpoint = new OpenWaEndpoint('http://127.0.0.1:2785', self::KEY, OutboundTarget::blocked('x'));

        $this->assertStringNotContainsString(self::KEY, print_r($endpoint, true));
        $this->assertStringNotContainsString(self::KEY, var_export($endpoint->__debugInfo(), true));
        $this->assertSame(self::KEY, $endpoint->apiKey());
    }

    public function test_nothing_is_logged_by_the_client(): void
    {
        Log::spy();
        Http::fake(['*' => $this->answer(['valid' => true, 'role' => 'admin', 'engineType' => 'baileys'])]);

        $this->client()->ping();

        Log::shouldNotHaveReceived('info');
        Log::shouldNotHaveReceived('debug');
        Log::shouldNotHaveReceived('warning');
    }
}
