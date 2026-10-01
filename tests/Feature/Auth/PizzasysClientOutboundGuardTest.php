<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Support\Network\HostResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeHostResolver;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * The portal client re-applies the outbound guard right before EVERY call: an address that was fine when it was saved
 * (or that now resolves to an internal host) never gets a request, and with it the bearer token.
 */
class PizzasysClientOutboundGuardTest extends TestCase
{
    use RefreshDatabase;

    private FakeHostResolver $resolver;

    /** @var list<array{url: string, authorization: string|null, options: array<string, mixed>}> */
    private array $sent = [];

    protected function setUp(): void
    {
        parent::setUp();

        $this->resolver = new FakeHostResolver;
        $this->app->instance(HostResolver::class, $this->resolver);

        Http::fake(function (Request $request, array $options) {
            $this->sent[] = ['url' => $request->url(), 'authorization' => $request->header('Authorization')[0] ?? null, 'options' => $options];

            return Http::response(PizzasysMock::fixture('token-verify-inactive'), 200);
        });
    }

    private function endpoint(string $baseUrl = PizzasysMock::BASE_URL): PizzasysEndpoint
    {
        return new PizzasysEndpoint('production', $baseUrl, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);
    }

    private function client(): PizzasysClient
    {
        return app(PizzasysClient::class);
    }

    public function test_the_connection_is_pinned_to_the_address_that_was_just_validated(): void
    {
        $this->resolver->map['auth.example.test'] = ['93.184.216.34', '2606:4700:4700::1111'];

        $this->client()->verify($this->endpoint(), '1|abc');

        $this->assertCount(1, $this->sent);
        $this->assertSame(['auth.example.test:443:93.184.216.34,[2606:4700:4700::1111]'], $this->sent[0]['options']['curl'][CURLOPT_RESOLVE]);
        $this->assertSame(['auth.example.test'], $this->resolver->lookups, 'one lookup, by the guard');
    }

    public function test_an_ip_address_in_the_base_url_needs_no_pinning(): void
    {
        $this->client()->verify($this->endpoint('https://8.8.8.8'), '1|abc');

        $this->assertCount(1, $this->sent);
        $this->assertArrayNotHasKey('curl', $this->sent[0]['options']);
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function internalBaseUrls(): array
    {
        return [
            'metadata' => ['https://169.254.169.254'],
            'mapped metadata' => ['https://[::ffff:169.254.169.254]'],
            'decimal' => ['https://2852039166'],
            'loopback' => ['https://127.0.0.1'],
            'private' => ['https://10.0.0.5'],
            'localhost' => ['http://localhost:6379'],
        ];
    }

    #[DataProvider('internalBaseUrls')]
    public function test_an_internal_address_gets_no_request_and_looks_like_an_unreachable_portal(string $baseUrl): void
    {
        $endpoint = $this->endpoint($baseUrl);
        $client = $this->client();

        $login = $client->login($endpoint, 'a@b.test', 'password');
        $verify = $client->verify($endpoint, '1|abc');
        $me = $client->me($endpoint, '1|abc');
        $logout = $client->logout($endpoint, '1|abc');
        $probe = $client->probe($endpoint);

        $this->assertSame([], $this->sent, 'nothing was sent: no token, no password');
        $this->assertSame(PortalStatus::Unavailable, $login->status);
        $this->assertSame(PortalFailure::BLOCKED, $login->reason);
        $this->assertSame(PortalStatus::Unavailable, $verify->status);
        $this->assertSame(PortalStatus::Unavailable, $me->status);
        $this->assertFalse($logout);
        $this->assertFalse($probe->reachable);
        $this->assertSame(PortalFailure::message(PortalFailure::CONNECTION), $probe->message, 'the same sentence as a connection failure');
    }

    public function test_a_name_that_now_resolves_to_an_internal_host_is_refused_at_call_time(): void
    {
        $endpoint = $this->endpoint();

        $this->assertSame(PortalStatus::Inactive, $this->client()->verify($endpoint, '1|abc')->status);

        // the DNS answer changes after the address was saved (DNS rebinding)
        $this->resolver->map['auth.example.test'] = [FakeHostResolver::PUBLIC_ADDRESS, '10.0.0.5'];

        $this->assertSame(PortalStatus::Unavailable, $this->client()->verify($endpoint, '1|abc')->status);
        $this->assertCount(1, $this->sent, 'the second call was never made, so the service token never left');
    }

    public function test_private_hosts_are_reachable_when_the_deployment_allows_them(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);
        $this->resolver->map['auth.example.test'] = ['10.0.0.5'];

        $this->assertSame(PortalStatus::Inactive, $this->client()->verify($this->endpoint(), '1|abc')->status);
        $this->assertCount(1, $this->sent);
    }

    public function test_the_metadata_address_is_never_reachable_not_even_on_a_private_deployment(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertSame(PortalStatus::Unavailable, $this->client()->verify($this->endpoint('https://169.254.169.254'), '1|abc')->status);
        $this->assertSame([], $this->sent);
    }

    public function test_the_connection_test_of_a_blocked_address_reveals_nothing(): void
    {
        $result = app(TestPortalConnection::class)($this->endpoint('https://10.0.0.5'));

        $this->assertFalse($result->ok);
        $messages = array_map(fn ($check) => is_string($check->message) ? $check->message : null, $result->checks);
        $this->assertSame(PortalFailure::message(PortalFailure::CONNECTION), $messages[0]);
        $this->assertStringNotContainsString('10.0.0.5', (string) json_encode($result->toArray()));
        $this->assertSame([], $this->sent);
    }
}
