<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Actions\SendTestPush;
use App\Domain\Notifications\Channels\WebPushChannel;
use App\Domain\Notifications\Contracts\PushChannel;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Support\PushDeadlineExceeded;
use App\Domain\Notifications\Support\PushEndpointGuard;
use App\Domain\Notifications\Support\PushHttpClient;
use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;
use App\Models\User;
use App\Support\Network\HostResolver;
use GuzzleHttp\Psr7\Request as PsrRequest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeHostResolver;
use Tests\Support\InteractsWithWebPush;
use Tests\TestCase;

/**
 * S1 / S7: the push endpoint is a request-forgery target a browser chooses. Public https hosts only, on EVERY setting (the switch that lets
 * the OpenWA gateway and the auth portal live on a private network never applies to a push endpoint), judged once per send and pinned
 * for the connection, optionally narrowed to a list of push services, and a test push is bounded in devices and total time.
 */
class PushEndpointGuardTest extends TestCase
{
    use InteractsWithWebPush, RefreshDatabase;

    private FakeHostResolver $resolver;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useVapid();
        $this->resolver = new FakeHostResolver([
            'private.push.test' => ['10.1.2.3'],
            'loopback.push.test' => ['127.0.0.1'],
            'mixed.push.test' => [FakeHostResolver::PUBLIC_ADDRESS, '10.0.0.5'],
            'metadata.push.test' => ['169.254.169.254'],
            'mapped.push.test' => ['::ffff:127.0.0.1'],
            'v6.push.test' => ['2606:4700:4700::1111'],
            'nothing.push.test' => [],
        ]);
        $this->app->instance(HostResolver::class, $this->resolver);
        // The channel and the dispatcher are singletons that were built (with the guard, with the default resolver) before this test's own.
        $this->app->forgetInstance(WebPushChannel::class);
        $this->app->forgetInstance(PushDispatcher::class);
    }

    private function guard(): PushEndpointGuard
    {
        return $this->app->make(PushEndpointGuard::class);
    }

    /** Both ways the private-network switch can be thrown: the setting and a local environment. */
    private function privateSwitchOn(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);
        $this->app->detectEnvironment(fn (): string => 'local');
    }

    // ---- what passes ---------------------------------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string}>
     */
    public static function publicEndpoints(): array
    {
        return [
            'chrome / edge' => ['https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH'],
            'firefox' => ['https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk'],
            'safari' => ['https://web.push.apple.com/QGmK7Zk'],
            'windows, with a token query' => ['https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2f'],
            'explicit standard port' => ['https://fcm.googleapis.com:443/fcm/send/abc'],
            'upper case host' => ['https://FCM.GoogleAPIs.com/fcm/send/abc'],
            'a public ipv4 literal' => ['https://8.8.8.8/push/abc'],
            'a public ipv6 literal' => ['https://[2606:4700:4700::1111]/push/abc'],
            'a name with a public ipv6 answer' => ['https://v6.push.test/push/abc'],
        ];
    }

    #[DataProvider('publicEndpoints')]
    public function test_a_public_https_push_service_passes_with_the_private_switch_on_or_off(string $endpoint): void
    {
        $this->assertTrue($this->guard()->allows($endpoint));

        $this->privateSwitchOn();
        $this->assertTrue($this->guard()->allows($endpoint));
    }

    // ---- what never passes ---------------------------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string}>
     */
    public static function refusedEndpoints(): array
    {
        return [
            'loopback ipv4' => ['https://127.0.0.1/x'],
            'loopback anywhere in 127/8' => ['https://127.8.9.10/x'],
            'localhost' => ['https://localhost/x'],
            'localhost with a root dot' => ['https://localhost./x'],
            'loopback ipv6' => ['https://[::1]/x'],
            'ipv4-mapped loopback' => ['https://[::ffff:127.0.0.1]/x'],
            'ipv4-mapped private' => ['https://[::ffff:10.0.0.1]/x'],
            'rfc1918 10/8' => ['https://10.0.0.5/x'],
            'rfc1918 172.16/12' => ['https://172.16.0.1/x'],
            'rfc1918 192.168/16' => ['https://192.168.1.1/x'],
            'carrier-grade nat' => ['https://100.64.0.1/x'],
            'link-local / cloud metadata' => ['https://169.254.169.254/latest/meta-data/'],
            'link-local ipv6' => ['https://[fe80::1]/x'],
            'unique-local ipv6' => ['https://[fd00::1]/x'],
            'unspecified' => ['https://0.0.0.0/x'],
            'hex octet spelling' => ['https://0x7f.1/x'],
            'full hex spelling' => ['https://0x7f000001/x'],
            'decimal spelling' => ['https://2130706433/x'],
            'octal spelling' => ['https://0177.0.0.1/x'],
            'short spelling' => ['https://127.1/x'],
            'a metadata name' => ['https://metadata.google.internal/x'],
            'an internal suffix' => ['https://printer.local/x'],
            'a single-label name' => ['https://intranet/x'],
            'a name that resolves to a private address' => ['https://private.push.test/x'],
            'a name that resolves to loopback' => ['https://loopback.push.test/x'],
            'a name with one public and one private answer' => ['https://mixed.push.test/x'],
            'a name that resolves to the metadata address' => ['https://metadata.push.test/x'],
            'a name that resolves to a mapped loopback' => ['https://mapped.push.test/x'],
            'a name that does not resolve' => ['https://nothing.push.test/x'],
            'plain http' => ['http://fcm.googleapis.com/fcm/send/abc'],
            'another scheme' => ['ftp://fcm.googleapis.com/x'],
            'a non-standard port' => ['https://fcm.googleapis.com:8443/fcm/send/abc'],
            'credentials in the url' => ['https://user:pass@fcm.googleapis.com/x'],
            'a user name only' => ['https://user@fcm.googleapis.com/x'],
            'a fragment' => ['https://fcm.googleapis.com/x#frag'],
            'a backslash that curl and the parser might read differently' => ['https://fcm.googleapis.com\\@127.0.0.1/x'],
            'a space' => ['https://fcm.googleapis.com/x y'],
            'a control character' => ["https://fcm.googleapis.com/x\r\nHost: evil"],
            'a non-ascii host' => ['https://fcm.googleapis.com.xn--e1afmkfd/x'.'é'],
            'a trailing root dot' => ['https://fcm.googleapis.com./x'],
            'no host' => ['https:///x'],
            'empty' => [''],
            'not a url' => ['not a url'],
        ];
    }

    #[DataProvider('refusedEndpoints')]
    public function test_a_dangerous_or_odd_endpoint_is_refused_with_the_private_switch_off_and_on(string $endpoint): void
    {
        $this->assertFalse($this->guard()->allows($endpoint), 'switch off');

        $this->privateSwitchOn();
        $this->app->forgetInstance(PushEndpointGuard::class);
        $this->assertFalse($this->guard()->allows($endpoint), 'switch on');
    }

    public function test_an_endpoint_longer_than_the_column_is_refused(): void
    {
        $this->assertFalse($this->guard()->allows('https://fcm.googleapis.com/'.str_repeat('a', PushEndpointGuard::MAX_LENGTH)));
    }

    // ---- the allow-list ------------------------------------------------------------------------------------------------------

    public function test_with_a_list_only_the_listed_hosts_pass_and_a_wildcard_never_matches_the_bare_domain(): void
    {
        config(['push.allowed_hosts' => ['fcm.googleapis.com', '*.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com', 'push.example.com:8443']]);

        foreach ([
            'https://fcm.googleapis.com/fcm/send/abc',
            'https://updates.push.services.mozilla.com/wpush/v2/abc',
            'https://web.push.apple.com/abc',
            'https://wns2-par02p.notify.windows.com/w/?token=abc',
            'https://a.b.notify.windows.com/w/',
            'https://push.example.com:8443/abc',
        ] as $allowed) {
            $this->assertTrue($this->guard()->allows($allowed), $allowed);
        }

        foreach ([
            'https://example.com/push/abc',
            'https://push.services.mozilla.com/abc',
            'https://notify.windows.com/abc',
            'https://evil-fcm.googleapis.com/abc',
            'https://fcm.googleapis.com.attacker.example/abc',
            'https://updates.push.services.mozilla.com.attacker.example/abc',
            'https://fcm.googleapis.com:8443/abc',
            'https://push.example.com/abc',
            'https://web.push.apple.com:8443/abc',
        ] as $refused) {
            $this->assertFalse($this->guard()->allows($refused), $refused);
        }
    }

    public function test_a_listed_host_that_resolves_privately_is_still_refused_even_with_the_private_switch_on(): void
    {
        config(['push.allowed_hosts' => ['*.push.test']]);
        $this->privateSwitchOn();

        $this->assertFalse($this->guard()->allows('https://private.push.test/x'));
        $this->assertFalse($this->guard()->allows('https://mixed.push.test/x'));
        $this->assertTrue($this->guard()->allows('https://v6.push.test/x'));
    }

    public function test_a_listed_port_does_not_open_other_ports_or_other_hosts(): void
    {
        config(['push.allowed_hosts' => ['push.example.com:8443', 'fcm.googleapis.com']]);

        $this->assertTrue($this->guard()->allows('https://push.example.com:8443/x'));
        $this->assertFalse($this->guard()->allows('https://push.example.com:8444/x'));
        $this->assertFalse($this->guard()->allows('https://fcm.googleapis.com:8443/x'));
    }

    // ---- the judgement is resolved once and remembered ----------------------------------------------------------------------

    public function test_a_host_is_resolved_once_per_cache_window_however_many_endpoints_use_it(): void
    {
        foreach (range(1, 5) as $index) {
            $this->assertTrue($this->guard()->allows('https://fcm.googleapis.com/fcm/send/'.$index));
        }

        $this->assertSame(['fcm.googleapis.com'], $this->resolver->lookups);

        $this->travel(61)->seconds();
        $this->assertTrue($this->guard()->allows('https://fcm.googleapis.com/fcm/send/6'));
        $this->assertSame(['fcm.googleapis.com', 'fcm.googleapis.com'], $this->resolver->lookups);
    }

    public function test_a_refusal_is_remembered_too(): void
    {
        $this->assertFalse($this->guard()->allows('https://private.push.test/a'));
        $this->assertFalse($this->guard()->allows('https://private.push.test/b'));

        $this->assertSame(['private.push.test'], $this->resolver->lookups);
    }

    // ---- sending: pinned, judged just before, bounded ------------------------------------------------------------------------

    /**
     * Records the Guzzle options of every push request (the global middleware sees what the client was configured with).
     *
     * @return \ArrayObject<int, array<string, mixed>>
     */
    private function recordClientOptions(): \ArrayObject
    {
        $seen = new \ArrayObject;
        Http::globalMiddleware(fn (callable $handler): callable => function ($request, array $options) use ($handler, $seen) {
            $seen[] = $options;

            return $handler($request, $options);
        });

        return $seen;
    }

    private function offer(): PushMessage
    {
        return new PushMessage(PushType::Message, 'chat-01JTAG', 'New message', 'Hello', '/inbox/01JTAG', 90, 'normal');
    }

    public function test_the_connection_is_pinned_to_the_address_that_was_judged_and_redirects_are_off(): void
    {
        $this->fakePushService();
        $seen = $this->recordClientOptions();
        $agent = User::factory()->agent()->create();
        $this->subscribe($agent);
        $this->subscribe($agent);

        $result = $this->app->make(WebPushChannel::class)->deliver($agent->id, $this->offer());

        $this->assertSame(2, $result->sent);
        $this->assertSame(['fcm.googleapis.com'], $this->resolver->lookups, 'one lookup for both devices');
        $this->assertCount(2, $seen);

        foreach ($seen as $options) {
            $this->assertFalse($options['allow_redirects']);
            $this->assertSame(10, $options['timeout'], 'the per-request timeout really reaches the client');
            $this->assertSame(5, $options['connect_timeout']);
            $this->assertSame(['fcm.googleapis.com:443:'.FakeHostResolver::PUBLIC_ADDRESS], $options['curl'][CURLOPT_RESOLVE]);
        }
    }

    public function test_a_name_re_pointed_at_the_internal_network_after_the_judgement_is_not_followed(): void
    {
        $this->fakePushService();
        $seen = $this->recordClientOptions();
        $agent = User::factory()->agent()->create();
        $this->subscribe($agent);
        $channel = $this->app->make(WebPushChannel::class);

        $this->assertSame(1, $channel->deliver($agent->id, $this->offer())->sent);

        // DNS now answers with a private address: within the cache window the request still goes to the judged one (pinned) ...
        $this->resolver->map['fcm.googleapis.com'] = ['10.0.0.5'];
        $this->assertSame(1, $channel->deliver($agent->id, $this->offer())->sent);
        $this->assertSame(FakeHostResolver::PUBLIC_ADDRESS, explode(':', $seen[1]['curl'][CURLOPT_RESOLVE][0])[2]);

        // ... and once the judgement expires the new answer is judged and the endpoint is refused: nothing is sent.
        $this->travel(61)->seconds();
        $result = $channel->deliver($agent->id, $this->offer());

        $this->assertSame(0, $result->sent);
        $this->assertSame(1, $result->failed);
        $this->assertCount(2, $this->pushRequests());
    }

    public function test_an_endpoint_that_resolves_to_the_internal_network_is_never_contacted_even_with_the_private_switch_on(): void
    {
        Http::fake();
        $this->privateSwitchOn();
        $agent = User::factory()->agent()->create();
        $this->subscribe($agent, ['endpoint' => 'https://private.push.test/push/abc']);
        $this->subscribe($agent, ['endpoint' => 'https://loopback.push.test/push/abc']);

        $result = $this->app->make(WebPushChannel::class)->deliver($agent->id, $this->offer());

        $this->assertSame(2, $result->failed);
        $this->assertSame(0, $result->sent);
        Http::assertNothingSent();
    }

    public function test_the_client_refuses_to_start_a_request_after_its_deadline(): void
    {
        Http::fake();
        $client = new PushHttpClient(5, [], microtime(true) - 1);

        $this->expectException(PushDeadlineExceeded::class);

        try {
            $client->sendRequest(new PsrRequest('POST', 'https://fcm.googleapis.com/fcm/send/abc'));
        } finally {
            Http::assertNothingSent();
        }
    }

    public function test_a_deadline_hands_back_the_devices_it_did_not_reach_as_retries(): void
    {
        // Each push "takes" 0.7 s: with a one second budget the first two start in time, the third does not.
        Http::fake(function () {
            usleep(700_000);

            return Http::response('', 201);
        });
        $agent = User::factory()->agent()->create();
        $first = $this->subscribe($agent);
        $second = $this->subscribe($agent);
        $third = $this->subscribe($agent);

        $result = $this->app->make(WebPushChannel::class)->deliver($agent->id, $this->offer(), null, 5, 1);

        $this->assertSame(2, $result->sent);
        $this->assertCount(1, $result->retry);
        $this->assertContains($result->retry[0], [$first->id, $second->id, $third->id]);
    }

    public function test_the_test_push_is_capped_in_devices_and_in_total_time(): void
    {
        config(['push.test.max_devices' => 2, 'push.test.deadline_seconds' => 99]);
        $this->fakePushService();
        $agent = User::factory()->agent()->create();
        $old = $this->subscribe($agent, ['last_used_at' => now()->subDays(3)]);
        $recent = $this->subscribe($agent, ['last_used_at' => now()->subMinute()]);
        $newest = $this->subscribe($agent, ['last_used_at' => now()]);

        $answer = $this->app->make(SendTestPush::class)->handle($agent);

        $this->assertSame(2, $answer['devices']);
        $this->assertSame(2, $answer['sent']);
        $urls = array_map(fn ($request): string => $request->url(), $this->pushRequests());
        $this->assertEqualsCanonicalizing([$recent->endpoint, $newest->endpoint], $urls);
        $this->assertNotContains($old->endpoint, $urls);
    }

    public function test_the_test_push_never_runs_longer_than_ten_seconds_whatever_is_configured(): void
    {
        config(['push.test.deadline_seconds' => 600, 'push.test.max_devices' => 500]);
        $channel = new class implements PushChannel
        {
            /** @var list<array{targets: list<int>|null, timeout: int|null, deadline: int|null}> */
            public array $calls = [];

            public function name(): string
            {
                return 'recording';
            }

            public function isEnabled(): bool
            {
                return true;
            }

            public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
            {
                $this->calls[] = ['targets' => $targetIds, 'timeout' => $timeoutSeconds, 'deadline' => $deadlineSeconds];

                return new PushResult(sent: count($targetIds ?? []));
            }
        };
        $this->app->instance(PushDispatcher::class, new PushDispatcher([$channel]));
        $agent = User::factory()->agent()->create();
        $this->subscribe($agent);

        $this->app->make(SendTestPush::class)->handle($agent);

        $this->assertCount(1, $channel->calls);
        $this->assertSame(10, $channel->calls[0]['deadline']);
        $this->assertSame(5, $channel->calls[0]['timeout']);
    }

    public function test_a_queued_push_gets_the_job_deadline(): void
    {
        config(['push.job.deadline_seconds' => 42]);
        $channel = new class implements PushChannel
        {
            public ?int $deadline = null;

            public function name(): string
            {
                return 'recording';
            }

            public function isEnabled(): bool
            {
                return true;
            }

            public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult
            {
                $this->deadline = $deadlineSeconds;

                return new PushResult;
            }
        };
        $agent = User::factory()->agent()->create();

        $job = new SendPushToUser($agent->id, $this->offer()->toArray(), now()->getTimestamp());
        $job->handle(new PushDispatcher([$channel]));

        $this->assertSame(42, $channel->deadline);
        $this->assertSame(72, $job->timeout, 'the worker lets the job run its deadline plus a margin');
    }
}
