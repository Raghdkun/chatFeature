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

    /** OpenWA's recorded answer of a fixture: its status, its headers (`Retry-After` ...) and its body. */
    private function recorded(string $fixture): PromiseInterface
    {
        $status = OpenWaFixtures::status($fixture);
        $body = OpenWaFixtures::body($fixture);

        return Http::response($body === [] && in_array($status, [204, 205], true) ? '' : $body, $status, OpenWaFixtures::headers($fixture));
    }

    // ---- the happy path of every call --------------------------------------------------------------------------------------

    public function test_ping_posts_to_validate_with_the_key_header_and_reads_role_and_engine(): void
    {
        Http::fake(['*' => $this->recorded('auth-validate-ok')]);

        $ping = $this->client()->ping();

        $this->assertSame('admin', $ping->role);
        $this->assertSame('whatsapp-web.js', $ping->engine);
        $this->assertTrue($ping->canOperate());
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === 'http://127.0.0.1:2785/api/auth/validate'
            && $request->header('X-API-Key') === [self::KEY]
            && $request->header('Accept') === ['application/json']);
    }

    public function test_create_session_sends_the_name_and_returns_the_session(): void
    {
        Http::fake(['*' => $this->recorded('sessions-create')]);

        $session = $this->client()->createSession('rec-plain-0svf2');

        $this->assertSame('9460cf41-134f-40de-b6d6-b2322a32dd31', $session->id);
        $this->assertSame(SessionStatus::Created, $session->status);
        $this->assertFalse($session->engineLoaded);
        Http::assertSent(fn (Request $request): bool => $request->method() === 'POST'
            && $request->url() === 'http://127.0.0.1:2785/api/sessions'
            && $request->data() === ['name' => 'rec-plain-0svf2']);
    }

    public function test_start_and_stop_post_without_a_body_and_map_the_wire_status(): void
    {
        // Recorded: starting BLOCKS until the engine waits for a scan and answers `qr_ready`, stopping answers `disconnected`.
        Http::fake([
            '*/start' => $this->recorded('sessions-start'),
            '*/stop' => $this->recorded('sessions-stop'),
        ]);

        $this->assertSame(SessionStatus::Qr, $this->client()->startSession(self::SESSION)->status);
        $this->assertSame(SessionStatus::Disconnected, $this->client()->stopSession(self::SESSION)->status);

        Http::assertSent(fn (Request $request): bool => $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION.'/start' && $request->body() === '');
        Http::assertSent(fn (Request $request): bool => $request->url() === 'http://127.0.0.1:2785/api/sessions/'.self::SESSION.'/stop');
    }

    public function test_get_session_reads_phone_push_name_and_connection_time(): void
    {
        Http::fake(['*' => $this->recorded('sessions-get-ready')]);

        $session = $this->client()->getSession(self::SESSION);

        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('+4915100000000', $session->phone, 'OpenWA reports bare digits, the application keeps E.164');
        $this->assertSame('PNE Support', $session->pushName);
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
        Http::fake(['*' => $this->recorded('sessions-qr')]);

        $qr = $this->client()->getQr(self::SESSION);

        $this->assertSame(OpenWaFixtures::PNG_DATA_URL, $qr->dataUrl);
        $this->assertSame(SessionStatus::Qr, $qr->status);
        Http::assertSent(fn (Request $request): bool => str_ends_with($request->url(), '/api/sessions/'.self::SESSION.'/qr'));
    }

    public function test_register_webhook_sends_url_events_and_secret_and_reads_only_the_id_back(): void
    {
        Http::fake(['*' => $this->recorded('webhooks-create')]);

        $webhook = $this->client()->registerWebhook(self::SESSION, 'https://chat.example/webhooks/openwa/01J', 'a-webhook-secret-of-40-characters-0123456789', ['message.received', 'message.ack']);

        $this->assertSame('07bddd6b-1947-46aa-8237-e591c6b9be5d', $webhook->id);
        $this->assertTrue($webhook->active);
        $this->assertStringNotContainsString('secret', json_encode((array) $webhook), 'OpenWA never returns the secret');
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
        Http::fake(['*' => $this->recorded('messages-send-text-ok')]);

        $result = $this->client()->sendText(self::SESSION, '628123456789@c.us', 'Hello from OpenWA!');

        $this->assertSame('true_4915112345678@c.us_3EB0AB12CD34', $result->messageId);
        $this->assertSame(1790932560, $result->timestamp->getTimestamp());
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
        Http::fake(['*' => $this->recorded('error-send-pacing-limited')]);

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
            ->push(OpenWaFixtures::body('sessions-get-ready'), 200)]);

        $this->assertSame(SessionStatus::Ready, $this->client()->getSession(self::SESSION)->status);
        Http::assertSentCount(2);
    }

    public function test_a_get_gives_up_after_one_repeat(): void
    {
        Http::fake(['*' => Http::sequence()->pushFailedConnection()->pushFailedConnection()->push(OpenWaFixtures::body('sessions-get-ready'), 200)]);

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

    // ---- every recorded answer, through the client --------------------------------------------------------------------------

    /**
     * Fixture => what the client must make of it: a Closure that makes the call and returns something to compare, and the expectation
     * (a class-string of the exception it must throw, or a Closure that checks the result).
     *
     * @return iterable<string, array{string, Closure(OpenWaHttpClient): mixed, string|Closure(mixed): void}>
     */
    public static function recordedAnswers(): iterable
    {
        $id = '0e229df2-8c73-4536-a49c-22cb510a5702';

        yield 'ping, admin key' => ['auth-validate-ok', fn (OpenWaHttpClient $c) => $c->ping(), fn ($r) => self::assertTrue($r->canOperate())];
        yield 'ping, viewer key' => ['auth-validate-viewer', fn (OpenWaHttpClient $c) => $c->ping(), fn ($r) => self::assertFalse($r->canOperate())];
        yield 'ping, invalid key' => ['auth-validate-invalid-key', fn (OpenWaHttpClient $c) => $c->ping(), OpenWaRejected::class];
        yield 'ping, missing key' => ['auth-validate-missing-key', fn (OpenWaHttpClient $c) => $c->ping(), OpenWaRejected::class];
        yield 'create, operator key' => ['auth-operator-create-session-ok', fn (OpenWaHttpClient $c) => $c->createSession('rec-operator-0svf2'), fn ($r) => self::assertSame(SessionStatus::Created, $r->status)];
        yield 'create, scoped key refused' => ['auth-scoped-create-session-forbidden', fn (OpenWaHttpClient $c) => $c->createSession('abc'), OpenWaRejected::class];
        yield 'create, viewer refused' => ['auth-viewer-create-session-forbidden', fn (OpenWaHttpClient $c) => $c->createSession('abc'), OpenWaRejected::class];
        yield 'create, scoped key on another session is 401' => ['auth-scoped-other-session', fn (OpenWaHttpClient $c) => $c->getSession($id), fn () => null];
        yield 'create, duplicate name' => ['sessions-create-duplicate', fn (OpenWaHttpClient $c) => $c->createSession('rec-plain-0svf2'), OpenWaRejected::class];
        yield 'create, bad name' => ['sessions-create-name-characters', fn (OpenWaHttpClient $c) => $c->createSession('bad name'), OpenWaRejected::class];
        yield 'create, malformed JSON is a 404' => ['sessions-create-malformed-json', fn (OpenWaHttpClient $c) => $c->createSession('abc'), OpenWaRejected::class];
        yield 'get' => ['sessions-get', fn (OpenWaHttpClient $c) => $c->getSession($id), fn ($r) => self::assertSame(SessionStatus::Created, $r->status)];
        yield 'get, initializing' => ['sessions-get-initializing', fn (OpenWaHttpClient $c) => $c->getSession($id), fn ($r) => self::assertSame(SessionStatus::Starting, $r->status)];
        yield 'get, qr_ready' => ['sessions-get-qr-ready', fn (OpenWaHttpClient $c) => $c->getSession($id), fn ($r) => self::assertSame(SessionStatus::Qr, $r->status)];
        yield 'get, failed' => ['sessions-get-failed', fn (OpenWaHttpClient $c) => $c->getSession($id), fn ($r) => self::assertSame(SessionStatus::Failed, $r->status)];
        yield 'get, unknown id' => ['sessions-get-not-found', fn (OpenWaHttpClient $c) => $c->getSession($id), OpenWaRejected::class];
        yield 'get, not a uuid' => ['sessions-get-not-uuid', fn (OpenWaHttpClient $c) => $c->getSession('nope'), OpenWaRejected::class];
        yield 'start' => ['sessions-start', fn (OpenWaHttpClient $c) => $c->startSession($id), fn ($r) => self::assertSame(SessionStatus::Qr, $r->status)];
        yield 'start twice' => ['sessions-start-twice', fn (OpenWaHttpClient $c) => $c->startSession($id), OpenWaRejected::class];
        yield 'stop' => ['sessions-stop', fn (OpenWaHttpClient $c) => $c->stopSession($id), fn ($r) => self::assertSame(SessionStatus::Disconnected, $r->status)];
        yield 'stop twice' => ['sessions-stop-twice', fn (OpenWaHttpClient $c) => $c->stopSession($id), fn ($r) => self::assertSame(SessionStatus::Disconnected, $r->status)];
        yield 'stop, never started' => ['sessions-stop-never-started', fn (OpenWaHttpClient $c) => $c->stopSession($id), fn ($r) => self::assertSame(SessionStatus::Disconnected, $r->status)];
        yield 'delete' => ['sessions-delete', fn (OpenWaHttpClient $c) => $c->deleteSession($id), fn () => null];
        yield 'delete a running session' => ['sessions-delete-running', fn (OpenWaHttpClient $c) => $c->deleteSession($id), fn () => null];
        yield 'delete twice' => ['sessions-delete-twice', fn (OpenWaHttpClient $c) => $c->deleteSession($id), fn ($r) => null];
        yield 'qr' => ['sessions-qr', fn (OpenWaHttpClient $c) => $c->getQr($id), fn ($r) => self::assertSame(OpenWaFixtures::PNG_DATA_URL, $r->dataUrl)];
        yield 'qr, not started' => ['sessions-qr-before-start', fn (OpenWaHttpClient $c) => $c->getQr($id), OpenWaRejected::class];
        yield 'qr, still initializing' => ['sessions-qr-initializing', fn (OpenWaHttpClient $c) => $c->getQr($id), OpenWaRejected::class];
        yield 'webhook, created' => ['webhooks-create', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'https://x.test/h', str_repeat('s', 40), ['message.received']), fn ($r) => self::assertSame('07bddd6b-1947-46aa-8237-e591c6b9be5d', $r->id)];
        yield 'webhook, default events' => ['webhooks-create-default-events', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'https://x.test/h', str_repeat('s', 40), []), fn ($r) => self::assertSame(['message.received'], $r->events)];
        yield 'webhook, private address (SSRF)' => ['webhooks-create-ssrf-private-ip', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'http://10.0.0.5/h', str_repeat('s', 40), ['message.received']), OpenWaRejected::class];
        yield 'webhook, loopback (SSRF)' => ['webhooks-create-ssrf-loopback', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'http://127.0.0.1/h', str_repeat('s', 40), ['message.received']), OpenWaRejected::class];
        yield 'webhook, limit of 16' => ['webhooks-create-limit', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'https://x.test/h', str_repeat('s', 40), ['message.received']), OpenWaRejected::class];
        yield 'webhook, unknown session' => ['webhooks-create-unknown-session', fn (OpenWaHttpClient $c) => $c->registerWebhook($id, 'https://x.test/h', str_repeat('s', 40), ['message.received']), OpenWaRejected::class];
        yield 'webhook, deleted' => ['webhooks-delete', fn (OpenWaHttpClient $c) => $c->deleteWebhook($id, 'w'), fn () => null];
        yield 'webhook, deleting what is gone' => ['webhooks-get-not-found', fn (OpenWaHttpClient $c) => $c->deleteWebhook($id, 'w'), OpenWaRejected::class];
        yield 'send, accepted' => ['messages-send-text-ok', fn (OpenWaHttpClient $c) => $c->sendText($id, '4915112345678@c.us', 'hi'), fn ($r) => self::assertSame('true_4915112345678@c.us_3EB0AB12CD34', $r->messageId)];
        yield 'send, engine not connected (409)' => ['messages-send-text-session-not-ready', fn (OpenWaHttpClient $c) => $c->sendText($id, 'c@c.us', 'hi'), OpenWaRejected::class];
        yield 'send, not active (400)' => ['messages-send-text-session-not-started', fn (OpenWaHttpClient $c) => $c->sendText($id, 'c@c.us', 'hi'), OpenWaRejected::class];
        yield 'send, too long' => ['messages-send-text-too-long', fn (OpenWaHttpClient $c) => $c->sendText($id, 'c@c.us', 'hi'), OpenWaRejected::class];
        yield 'send, pacing limited' => ['error-send-pacing-limited', fn (OpenWaHttpClient $c) => $c->sendText($id, 'c@c.us', 'hi'), OpenWaPacingLimited::class];
        yield 'any call, throttled' => ['ratelimit-throttled', fn (OpenWaHttpClient $c) => $c->getSession($id), OpenWaRejected::class];
        yield 'create, name still being torn down' => ['error-session-name-teardown-pending', fn (OpenWaHttpClient $c) => $c->createSession('abc'), OpenWaRejected::class];
        yield 'start, engine did not come up (504)' => ['error-session-start-timeout', fn (OpenWaHttpClient $c) => $c->startSession($id), OpenWaUnavailable::class];
        yield 'stop, engine did not confirm (502)' => ['error-session-stop-incomplete', fn (OpenWaHttpClient $c) => $c->stopSession($id), OpenWaUnavailable::class];
        yield 'media, nothing stored' => ['messages-media-not-found', fn (OpenWaHttpClient $c) => $c->downloadMedia($id, 'c@c.us', 'm'), fn ($r) => self::assertNull($r)];
    }

    /**
     * @param  Closure(OpenWaHttpClient): mixed  $call
     * @param  string|Closure(mixed): void  $expect
     */
    #[DataProvider('recordedAnswers')]
    public function test_every_recorded_answer_is_understood_by_the_client(string $fixture, Closure $call, string|Closure $expect): void
    {
        Http::fake(['*' => $this->recorded($fixture)]);

        if (is_string($expect)) {
            try {
                $call($this->client());
                $this->fail("{$fixture} was accepted");
            } catch (OpenWaUnavailable|OpenWaRejected $exception) {
                $this->assertInstanceOf($expect, $exception, $fixture);

                if ($exception instanceof OpenWaRejected) {
                    $this->assertSame(OpenWaFixtures::status($fixture), $exception->status, $fixture);
                }
            }

            return;
        }

        try {
            $expect($call($this->client()));
        } catch (OpenWaRejected $rejected) {
            // The fixtures that only describe an odd answer (a scoped key's 401, deleting what is gone) just need to be understood.
            $this->assertContains($rejected->status, [401, 404], $fixture);
        }

        $this->addToAssertionCount(1);
    }

    public function test_the_error_codes_and_texts_of_the_recordings_reach_the_exceptions(): void
    {
        $current = null;
        Http::fake(['*' => function () use (&$current) {
            return $this->recorded((string) $current);
        }]);
        $by = function (string $fixture, Closure $call) use (&$current): OpenWaRejected {
            $current = $fixture;

            try {
                $call($this->client());
            } catch (OpenWaRejected $rejected) {
                return $rejected;
            }

            $this->fail("{$fixture} was accepted");
        };

        $teardown = $by('error-session-name-teardown-pending', fn (OpenWaHttpClient $c) => $c->createSession('abc'));
        $this->assertSame('SESSION_NAME_TEARDOWN_PENDING', $teardown->errorCode);
        $this->assertTrue($teardown->isConflict());

        $this->assertSame('SEND_PACING_LIMITED', $by('error-send-pacing-limited', fn (OpenWaHttpClient $c) => $c->sendText('s', 'c', 't'))->errorCode);
        $this->assertSame('rate_limited', $by('ratelimit-throttled', fn (OpenWaHttpClient $c) => $c->getSession('s'))->errorCode, 'the throttler has no code of its own');
        $this->assertSame('Destination address is not allowed', $by('webhooks-create-ssrf-private-ip', fn (OpenWaHttpClient $c) => $c->registerWebhook('s', 'http://10.0.0.5', str_repeat('s', 40), []))->getMessage());
        $this->assertStringContainsString('Webhook limit reached', $by('webhooks-create-limit', fn (OpenWaHttpClient $c) => $c->registerWebhook('s', 'https://x.test', str_repeat('s', 40), []))->getMessage());
        $this->assertStringContainsString('is not active', $by('messages-send-text-session-not-started', fn (OpenWaHttpClient $c) => $c->sendText('s', 'c', 't'))->getMessage());
        $this->assertTrue($by('messages-send-text-session-not-ready', fn (OpenWaHttpClient $c) => $c->sendText('s', 'c', 't'))->isConflict());
        $this->assertTrue($by('auth-scoped-other-session', fn (OpenWaHttpClient $c) => $c->getSession('s'))->isUnauthorized(), 'a scoped key outside its scope is a 401, and still "unauthorized"');
        $this->assertTrue($by('auth-viewer-create-session-forbidden', fn (OpenWaHttpClient $c) => $c->createSession('abc'))->isUnauthorized());
    }

    public function test_the_media_download_returns_the_documented_inert_bytes(): void
    {
        $file = OpenWaFixtures::file('messages-media-download-ok');
        $headers = (array) ($file['response']['headers'] ?? []);
        Http::fake(['*' => Http::response('JPEGBYTES', 200, ['Content-Type' => $headers['content-type'] ?? 'image/jpeg', 'Content-Disposition' => $headers['content-disposition'] ?? 'attachment'])]);

        $media = $this->client()->downloadMedia(self::SESSION, '4915112345678@c.us', '3EB0F00D0001');

        $this->assertNotNull($media);
        $this->assertSame('JPEGBYTES', $media->contents);
        $this->assertNotSame('', $media->mime);
    }
}
