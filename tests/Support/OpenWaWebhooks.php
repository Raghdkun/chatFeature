<?php

namespace Tests\Support;

use App\Domain\WhatsApp\Services\WebhookSignature;
use App\Models\WhatsAppSession;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Signed OpenWA webhook deliveries for the tests: bodies shaped like `docs/reference/openwa-api.md` section 6.6 (or a recorded fixture
 * of the same name, see {@see OpenWaFixtures}), the headers OpenWA sends, and the signature over the exact bytes of the body.
 *
 * @mixin TestCase
 */
trait OpenWaWebhooks
{
    protected const CUSTOMER = '4915123456789@c.us';

    /** A ready session whose webhook secret the test knows. */
    protected function webhookSession(string $secret = 'a-webhook-secret-of-forty-characters-0001', string $state = 'ready'): WhatsAppSession
    {
        return WhatsAppSession::factory()->{$state}()->withWebhook($secret)->create();
    }

    /**
     * Deliver a body to the webhook, signed with `$secret` unless a header is given explicitly (`false` omits it).
     *
     * @param  array<string, mixed>|string  $body  An array is JSON-encoded exactly once and signed as such; a string is sent as it is.
     * @param  array<string, string|false>  $headers  Header name => value (`false` removes it): `X-OpenWA-Signature`, `X-OpenWA-Idempotency-Key`, ...
     */
    protected function deliver(WhatsAppSession $session, array|string $body, ?string $secret = null, array $headers = []): TestResponse
    {
        $raw = is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $secret ??= $session->webhook_secret ?? '';
        $payload = is_array($body) ? $body : (json_decode($body, true) ?: []);

        $headers += [
            'X-OpenWA-Signature' => WebhookSignature::sign((string) $raw, $secret),
            'X-OpenWA-Event' => (string) ($payload['event'] ?? 'message.received'),
            'X-OpenWA-Idempotency-Key' => (string) ($payload['idempotencyKey'] ?? 'key_'.Str::random(12)),
            'X-OpenWA-Delivery-Id' => (string) ($payload['deliveryId'] ?? 'dlv_'.Str::uuid()),
            'X-OpenWA-Retry-Count' => '0',
        ];

        $server = ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'];

        foreach ($headers as $name => $value) {
            if ($value !== false) {
                $server['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;
            }
        }

        return $this->call('POST', '/webhooks/openwa/'.$session->ulid, [], [], [], $server, (string) $raw);
    }

    /**
     * An envelope with the given event and data, as OpenWA sends it.
     *
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    protected function envelope(string $event, array $data, ?string $key = null): array
    {
        return [
            'event' => $event,
            'timestamp' => now()->toIso8601ZuluString('millisecond'),
            'sessionId' => 'support-main',
            'idempotencyKey' => $key ?? $event.'_support-main_'.Str::random(10).'_f1e2d3c4-b5a6-7890-1234-567890abcdef',
            'deliveryId' => 'dlv_'.Str::uuid(),
            'data' => $data,
        ];
    }

    /**
     * A `message.received` of a customer (override anything in `data`).
     *
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    protected function messageReceived(array $data = [], ?string $key = null): array
    {
        $id = $data['id'] ?? 'false_'.self::CUSTOMER.'_'.Str::upper(Str::random(20));
        $data = $data + [
            'id' => $id,
            'from' => self::CUSTOMER,
            'to' => '6281234567890@c.us',
            'chatId' => self::CUSTOMER,
            'body' => 'Hello, I have a question',
            'type' => 'text',
            'timestamp' => now()->getTimestamp(),
            'isGroup' => false,
            'kind' => 'individual',
            'fromMe' => false,
            'contact' => ['name' => 'Anna Example', 'pushName' => 'Anna'],
        ];

        return $this->envelope('message.received', $data, $key ?? 'msg_support-main_'.$id.'_f1e2d3c4-b5a6-7890-1234-567890abcdef');
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    protected function messageAck(string $messageId, string $status, array $data = []): array
    {
        $ack = ['pending' => 0, 'sent' => 1, 'delivered' => 2, 'read' => 3, 'failed' => -1][$status] ?? 1;

        return $this->envelope($status === 'failed' ? 'message.failed' : 'message.ack', $data + [
            'id' => $messageId,
            'messageId' => $messageId,
            'status' => $status,
            'ack' => $ack,
        ], 'ack_support-main_'.$messageId.'_'.$status.'_f1e2d3c4-b5a6-7890-1234-567890abcdef');
    }
}
