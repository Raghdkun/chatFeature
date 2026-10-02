<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Realtime\Sockets\ReverbSocketTerminator;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Illuminate\Broadcasting\BroadcastException;
use Illuminate\Broadcasting\BroadcastManager;
use Psr\Http\Message\RequestInterface;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * The production terminator asks Reverb's control API (`POST /apps/{id}/users/{tag}/terminate_connections`), signed like a publish.
 * What Reverb does with it is proven with real sockets by `e2e/support/realtime-cutoff-smoke.mjs`; here the request is pinned.
 */
class ReverbSocketTerminatorTest extends TestCase
{
    use InteractsWithRealtime;

    /** @var list<array{request: RequestInterface}> */
    private array $history = [];

    /**
     * @param  list<Response|\Throwable>  $answers
     */
    private function reverbAnswers(array $answers): void
    {
        $this->useReverbBroadcaster();
        $this->history = [];

        $stack = HandlerStack::create(new MockHandler($answers));
        $stack->push(Middleware::history($this->history));

        config([
            'broadcasting.connections.reverb.options.host' => 'reverb.internal',
            'broadcasting.connections.reverb.options.port' => 8080,
            'broadcasting.connections.reverb.options.scheme' => 'http',
            'broadcasting.connections.reverb.options.useTLS' => false,
            'broadcasting.connections.reverb.client_options.handler' => $stack,
        ]);
        app(BroadcastManager::class)->purge('reverb');
    }

    public function test_it_posts_a_signed_terminate_call_for_the_tag(): void
    {
        $this->reverbAnswers([new Response(200, [], '{}')]);

        app(ReverbSocketTerminator::class)->terminate('s_0123456789abcdef01234567');

        $this->assertCount(1, $this->history);
        $request = $this->history[0]['request'];
        parse_str($request->getUri()->getQuery(), $query);

        $this->assertSame('POST', $request->getMethod());
        $this->assertSame('reverb.internal', $request->getUri()->getHost());
        $this->assertSame('/apps/123456/users/s_0123456789abcdef01234567/terminate_connections', $request->getUri()->getPath());
        $this->assertSame('{}', (string) $request->getBody());
        $this->assertSame(self::REVERB_KEY, $query['auth_key']);

        // The signature is the one Reverb verifies: HMAC-SHA256 over method, path and the sorted query (with the body's md5).
        $params = $query;
        unset($params['auth_signature']);
        ksort($params);
        $signed = hash_hmac('sha256', "POST\n".$request->getUri()->getPath()."\n".urldecode(http_build_query($params)), self::REVERB_SECRET);
        $this->assertSame($signed, $query['auth_signature']);
    }

    public function test_a_failure_is_thrown_without_the_signed_url(): void
    {
        $this->reverbAnswers([new Response(500, [], 'boom')]);

        try {
            app(ReverbSocketTerminator::class)->terminate('v_0123456789abcdef01234567');
            $this->fail('A failed call must throw so the caller retries it.');
        } catch (BroadcastException $exception) {
            foreach (['auth_signature', 'auth_key', 'body_md5', self::REVERB_KEY, 'auth_timestamp'] as $secret) {
                $this->assertStringNotContainsString($secret, $exception->getMessage());
            }
        }
    }

    public function test_without_reverb_as_the_broadcaster_there_is_nobody_to_ask(): void
    {
        config(['broadcasting.default' => 'null']);
        app(BroadcastManager::class)->purge('null');

        app(ReverbSocketTerminator::class)->terminate('s_0123456789abcdef01234567');

        $this->assertSame([], $this->history);
    }
}
