<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Realtime\Support\RedactedReverbBroadcaster;
use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Broadcasting\BroadcastException;
use Illuminate\Broadcasting\BroadcastManager;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * A failed publish is reported with its message: that message must not carry the signed publish URL.
 */
class RedactedReverbBroadcasterTest extends TestCase
{
    use InteractsWithRealtime;

    public function test_the_reverb_connection_is_the_redacting_pusher_broadcaster(): void
    {
        $this->useReverbBroadcaster();

        $broadcaster = app(BroadcastManager::class)->connection('reverb');

        $this->assertInstanceOf(RedactedReverbBroadcaster::class, $broadcaster);
        $this->assertInstanceOf(PusherBroadcaster::class, $broadcaster, 'the visitor endpoint signs through it');
    }

    public function test_a_failed_publish_names_the_problem_but_not_the_signature(): void
    {
        $this->useReverbBroadcaster();
        config([
            'broadcasting.connections.reverb.options.host' => '127.0.0.1',
            'broadcasting.connections.reverb.options.port' => 9,
            'broadcasting.connections.reverb.options.scheme' => 'http',
            'broadcasting.connections.reverb.options.useTLS' => false,
            'broadcasting.connections.reverb.client_options.connect_timeout' => 1,
        ]);
        app(BroadcastManager::class)->purge('reverb');

        try {
            app(BroadcastManager::class)->connection('reverb')->broadcast(['private-admin'], 'conversation.updated', ['v' => 1]);
            $this->fail('The publish should have failed.');
        } catch (BroadcastException $exception) {
            $this->assertStringContainsString('Failed to connect to 127.0.0.1 port 9', $exception->getMessage());
            $this->assertStringContainsString('/apps/123456/events?…', $exception->getMessage());

            foreach (['auth_signature', 'auth_key', 'body_md5', self::REVERB_KEY, 'auth_timestamp'] as $secret) {
                $this->assertStringNotContainsString($secret, $exception->getMessage());
            }
        }
    }

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function messages(): iterable
    {
        yield 'url in a sentence' => ['failed for http://reverb:8080/apps/1/events?auth_key=k&auth_signature=s done', 'failed for http://reverb:8080/apps/1/events?… done'];
        yield 'url in quotes' => ['"https://x.test/a?b=c" and \'https://y.test/?d=e\'', '"https://x.test/a?…" and \'https://y.test/?…\''];
        yield 'url in parentheses' => ['(see https://x.test/a?b=c)', '(see https://x.test/a?…)'];
        yield 'no query' => ['Failed to connect to reverb port 8080', 'Failed to connect to reverb port 8080'];
    }

    #[DataProvider('messages')]
    public function test_how_a_message_is_redacted(string $message, string $expected): void
    {
        $this->assertSame($expected, RedactedReverbBroadcaster::redact($message));
    }
}
