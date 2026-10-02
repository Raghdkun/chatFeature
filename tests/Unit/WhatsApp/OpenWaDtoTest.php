<?php

namespace Tests\Unit\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaWebhook;
use PHPUnit\Framework\TestCase;

/**
 * The shapes of docs/reference/openwa-api.md, parsed tolerantly: OpenWA answers without an envelope and may add fields at any time.
 */
class OpenWaDtoTest extends TestCase
{
    private const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    public function test_a_session_is_read_from_the_documented_response(): void
    {
        $session = OpenWaSession::fromArray([
            'id' => '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a',
            'name' => 'my-bot',
            'status' => 'ready',
            'phone' => '6281234567890',
            'pushName' => 'My Bot',
            'connectedAt' => '2026-06-25T08:14:02.000Z',
            'lastActive' => '2026-06-25T09:01:55.000Z',
            'createdAt' => '2026-06-20T11:30:00.000Z',
            'updatedAt' => '2026-06-25T09:01:55.000Z',
            'lastError' => null,
            'restriction' => null,
            'engineLoaded' => true,
            'somethingNew' => ['openwa', 'added', 'this'],
        ]);

        $this->assertSame('8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a', $session->id);
        $this->assertSame('my-bot', $session->name);
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('ready', $session->rawStatus);
        $this->assertSame('+6281234567890', $session->phone);
        $this->assertSame('My Bot', $session->pushName);
        $this->assertSame('2026-06-25T08:14:02+00:00', $session->connectedAt?->toIso8601String());
        $this->assertNull($session->lastError);
        $this->assertTrue($session->engineLoaded);
    }

    public function test_a_session_with_an_unknown_status_keeps_the_raw_one_and_no_mapped_status(): void
    {
        $session = OpenWaSession::fromArray(['id' => 'abc', 'name' => 'x', 'status' => 'hibernating', 'connectedAt' => 'not a date']);

        $this->assertNull($session->status);
        $this->assertSame('hibernating', $session->rawStatus);
        $this->assertNull($session->connectedAt);
        $this->assertNull($session->phone);
        $this->assertFalse($session->engineLoaded);
    }

    public function test_openwa_wire_statuses_become_ours(): void
    {
        foreach (['initializing' => SessionStatus::Starting, 'qr_ready' => SessionStatus::Qr, 'action_required' => SessionStatus::Failed] as $wire => $ours) {
            $this->assertSame($ours, OpenWaSession::fromArray(['id' => 'abc', 'status' => $wire])->status, $wire);
        }
    }

    public function test_a_session_without_an_id_is_refused(): void
    {
        $this->expectException(OpenWaUnavailable::class);

        OpenWaSession::fromArray(['name' => 'no-id', 'status' => 'ready']);
    }

    public function test_a_qr_is_a_png_data_url(): void
    {
        $qr = OpenWaQr::fromArray(['qrCode' => self::PNG, 'status' => 'qr_ready']);

        $this->assertSame(self::PNG, $qr->dataUrl);
        $this->assertSame(SessionStatus::Qr, $qr->status);
        $this->assertSame(self::PNG, OpenWaQr::fromArray(['qr' => self::PNG])->dataUrl, 'the session.qr webhook calls it `qr`');
    }

    public function test_anything_else_is_not_stored_as_a_qr(): void
    {
        foreach (['2@raw-linking-ref,abc', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', 'javascript:alert(1)', '', 42, null] as $bad) {
            try {
                OpenWaQr::fromArray(['qrCode' => $bad]);
                $this->fail('accepted '.var_export($bad, true));
            } catch (OpenWaUnavailable) {
                $this->addToAssertionCount(1);
            }
        }

        $this->expectException(OpenWaUnavailable::class);
        OpenWaQr::fromArray(['qrCode' => 'data:image/png;base64,'.str_repeat('A', OpenWaQr::MAX_LENGTH)]);
    }

    public function test_a_send_result_carries_the_message_id_and_the_epoch_seconds(): void
    {
        $result = OpenWaSendResult::fromArray(['messageId' => 'true_628123456789@c.us_3EB0ABCD', 'timestamp' => 1719312000]);

        $this->assertSame('true_628123456789@c.us_3EB0ABCD', $result->messageId);
        $this->assertSame(1719312000, $result->timestamp->getTimestamp());
    }

    public function test_a_send_without_a_message_id_is_not_an_acceptance(): void
    {
        $this->expectException(OpenWaUnavailable::class);

        OpenWaSendResult::fromArray(['timestamp' => 1719312000]);
    }

    public function test_a_webhook_never_carries_its_secret(): void
    {
        $webhook = OpenWaWebhook::fromArray([
            'id' => 'f1e2d3c4-b5a6-7890-1234-567890abcdef',
            'sessionId' => 'my-session',
            'url' => 'https://chat.example.com/webhooks/openwa/01J',
            'events' => ['message.received', 'session.status', 42],
            'filters' => null,
            'active' => true,
            'retryCount' => 3,
        ]);

        $this->assertSame('f1e2d3c4-b5a6-7890-1234-567890abcdef', $webhook->id);
        $this->assertSame(['message.received', 'session.status'], $webhook->events);
        $this->assertTrue($webhook->active);
        $this->assertSame(3, $webhook->retryCount);
        $this->assertFalse(property_exists($webhook, 'secret'));
    }

    public function test_the_connection_test_reads_the_key_role_and_engine(): void
    {
        $ping = OpenWaPing::fromArray(['valid' => true, 'role' => 'operator', 'engineType' => 'whatsapp-web.js']);

        $this->assertSame('operator', $ping->role);
        $this->assertSame('whatsapp-web.js', $ping->engine);
        $this->assertTrue($ping->canOperate());
        $this->assertFalse((new OpenWaPing('viewer', 'baileys'))->canOperate());

        $this->expectException(OpenWaUnavailable::class);
        OpenWaPing::fromArray(['valid' => false]);
    }

    public function test_media_knows_its_size(): void
    {
        $media = new OpenWaMedia('12345', 'image/jpeg', 'photo.jpg');

        $this->assertSame(5, $media->size());
        $this->assertSame('image/jpeg', $media->mime);
    }

    public function test_a_validation_error_body_becomes_a_rejection(): void
    {
        $error = OpenWaRejected::fromResponse(400, ['statusCode' => 400, 'message' => ['name must be longer than or equal to 3 characters', 'name must match pattern'], 'error' => 'Bad Request']);

        $this->assertSame('bad_request', $error->errorCode);
        $this->assertSame(400, $error->status);
        $this->assertSame('name must be longer than or equal to 3 characters; name must match pattern', $error->getMessage());
        $this->assertFalse($error->isNotFound());
    }

    public function test_the_machine_readable_code_of_the_body_wins(): void
    {
        $error = OpenWaRejected::fromResponse(409, ['statusCode' => 409, 'message' => 'teardown pending', 'code' => 'SESSION_NAME_TEARDOWN_PENDING']);

        $this->assertSame('SESSION_NAME_TEARDOWN_PENDING', $error->errorCode);
        $this->assertTrue($error->isConflict());
    }

    public function test_statuses_without_a_code_get_a_slug(): void
    {
        $this->assertSame('not_found', OpenWaRejected::fromResponse(404, ['message' => 'Session not found'])->errorCode);
        $this->assertTrue(OpenWaRejected::fromResponse(404, [])->isNotFound());
        $this->assertSame('unauthorized', OpenWaRejected::fromResponse(401, ['message' => 'Invalid API key'])->errorCode);
        $this->assertTrue(OpenWaRejected::fromResponse(401, [])->isUnauthorized());
        $this->assertTrue(OpenWaRejected::fromResponse(403, [])->isUnauthorized());
        $this->assertSame('rate_limited', OpenWaRejected::fromResponse(429, ['message' => 'ThrottlerException'])->errorCode, 'the global limiter has no code');
        $this->assertSame('rejected', OpenWaRejected::fromResponse(418, [])->errorCode);
        $this->assertNotSame('', OpenWaRejected::fromResponse(400, [])->getMessage());
    }

    public function test_a_pacing_refusal_says_when_to_come_back(): void
    {
        $error = OpenWaRejected::fromResponse(429, [
            'statusCode' => 429,
            'error' => 'Too Many Requests',
            'message' => 'Daily allowance of 5 new conversation(s) reached',
            'code' => 'SEND_PACING_LIMITED',
            'retryAfterSeconds' => 34521,
        ]);

        $this->assertInstanceOf(OpenWaPacingLimited::class, $error);
        $this->assertInstanceOf(OpenWaRejected::class, $error, 'a pacing refusal is a rejection');
        $this->assertSame(34521, $error->retryAfterSeconds);
        $this->assertSame('SEND_PACING_LIMITED', $error->errorCode);
        $this->assertSame(429, $error->status);
        $this->assertSame(120, OpenWaRejected::fromResponse(429, ['code' => 'SEND_PACING_LIMITED'], 120)->retryAfterSeconds ?? null, 'falls back to the Retry-After header');
    }

    public function test_a_long_error_message_is_cut(): void
    {
        $error = OpenWaRejected::fromResponse(400, ['message' => str_repeat('x', 2000)]);

        $this->assertSame(500, mb_strlen($error->getMessage()));
    }
}
