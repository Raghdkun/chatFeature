<?php

namespace Tests\Feature\Security;

use App\Domain\Widgets\Support\ClientNetwork;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * `POST /csp-report`: the public collector of the `report-uri`. It answers 204 to everything, logs each distinct violation once an
 * hour with short sanitised fields, sets no cookie and needs no CSRF token.
 */
class CspReportTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @param  array<string, mixed>  $body
     */
    private function report(array $body, string $type = 'application/csp-report'): TestResponse
    {
        return $this->call('POST', '/csp-report', [], [], [], ['CONTENT_TYPE' => $type], (string) json_encode($body));
    }

    /** @return array<string, mixed> */
    private function legacy(array $override = []): array
    {
        return ['csp-report' => $override + [
            'document-uri' => 'https://chat.example.test/inbox/01HZ?token=secret#frag',
            'effective-directive' => 'script-src-elem',
            'violated-directive' => 'script-src-elem',
            'blocked-uri' => 'https://evil.example/x.js?steal=1',
            'source-file' => 'https://chat.example.test/build/app.js',
            'line-number' => 12,
            'disposition' => 'report',
            'script-sample' => 'alert(document.cookie)',
        ]];
    }

    public function test_a_violation_is_answered_with_204_logged_once_and_sets_no_cookie(): void
    {
        Log::spy();

        $first = $this->report($this->legacy());
        $this->report($this->legacy());

        $first->assertNoContent();
        $this->assertSame([], $first->headers->getCookies());
        Log::shouldHaveReceived('warning')->once()->with('csp.violation', [
            'directive' => 'script-src-elem',
            'blocked' => 'https://evil.example',
            'page' => 'chat.example.test/inbox/01HZ',
            'source' => 'chat.example.test/build/app.js',
            'line' => 12,
            'disposition' => 'report',
        ]);
    }

    public function test_neither_the_query_nor_the_sample_of_the_blocked_code_reaches_the_log(): void
    {
        Log::spy();

        $this->report($this->legacy())->assertNoContent();

        Log::shouldHaveReceived('warning')->withArgs(function (string $message, array $context): bool {
            $line = json_encode($context);

            return ! str_contains((string) $line, 'secret') && ! str_contains((string) $line, 'steal') && ! str_contains((string) $line, 'alert(') && ! str_contains((string) $line, 'frag');
        })->once();
    }

    public function test_the_reporting_api_format_is_understood_too(): void
    {
        Log::spy();

        $this->report([['type' => 'csp-violation', 'url' => 'https://chat.example.test/', 'body' => [
            'documentURL' => 'https://chat.example.test/history', 'effectiveDirective' => 'img-src', 'blockedURL' => 'data', 'disposition' => 'enforce', 'lineNumber' => 3,
        ]]], 'application/reports+json')->assertNoContent();

        Log::shouldHaveReceived('warning')->once()->withArgs(fn (string $message, array $context): bool => $context['directive'] === 'img-src' && $context['blocked'] === 'data' && $context['page'] === 'chat.example.test/history');
    }

    public function test_distinct_violations_are_each_logged_and_log_injection_is_flattened(): void
    {
        Log::spy();

        $this->report($this->legacy(['effective-directive' => "img-src\nERROR forged line"]))->assertNoContent();
        $this->report($this->legacy(['blocked-uri' => 'inline']))->assertNoContent();

        Log::shouldHaveReceived('warning')->twice();
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message, array $context): bool => ! str_contains($context['directive'], "\n") && str_contains($context['directive'], 'forged'))->once();
    }

    public function test_garbage_is_answered_with_204_and_logs_nothing(): void
    {
        Log::spy();

        foreach (['', 'not json', '[]', '{"csp-report": "x"}', '{"csp-report": []}', str_repeat('A', 100_000)] as $body) {
            $this->call('POST', '/csp-report', [], [], [], ['CONTENT_TYPE' => 'application/csp-report'], $body)->assertNoContent();
        }

        $this->postJson('/csp-report', ['a' => 1])->assertNoContent();
        Log::shouldNotHaveReceived('warning');
    }

    public function test_it_needs_neither_a_session_nor_a_csrf_token_and_only_accepts_post(): void
    {
        $this->report($this->legacy())->assertNoContent();
        $this->get('/csp-report')->assertStatus(405);
    }

    public function test_a_network_that_floods_it_is_throttled(): void
    {
        Cache::flush();
        RateLimiter::clear('csp-report-ip:'.ClientNetwork::bucket('127.0.0.1'));

        for ($i = 0; $i < 20; $i++) {
            $this->report($this->legacy(['line-number' => $i]))->assertNoContent();
        }

        $this->report($this->legacy())->assertStatus(429);
    }
}
