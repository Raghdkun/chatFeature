<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\Results\PortalStatus;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * The raw portal client against recorded real responses (tests/fixtures/pizzasys): every outcome class the driver relies on.
 */
class PizzasysClientTest extends TestCase
{
    use RefreshDatabase;

    private PizzasysEndpoint $endpoint;

    protected function setUp(): void
    {
        parent::setUp();

        $this->endpoint = new PizzasysEndpoint('production', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);
    }

    private function client(): PizzasysClient
    {
        return app(PizzasysClient::class);
    }

    /**
     * @param  array<string, mixed>|string|null  $body
     */
    private function fakeStatus(int $status, array|string|null $body = null): void
    {
        $this->freshHttp()->fake([PizzasysMock::BASE_URL.'/*' => Http::response($body ?? [], $status)]);
    }

    /** `Http::fake()` stubs accumulate (the first match wins), so every scenario starts from a clean factory. */
    private function freshHttp(): HttpFactory
    {
        $factory = new HttpFactory;
        Http::swap($factory);

        return $factory;
    }

    /**
     * Every request fails at the transport level; returns a reference to the attempt counter.
     */
    private function failTransport(string $message, ?int &$attempts): void
    {
        $attempts = 0;

        $this->freshHttp()->fake(function () use ($message, &$attempts): never {
            $attempts++;

            throw new ConnectionException($message);
        });
    }

    private function fakeFixture(string $fixture): void
    {
        $this->fakeStatus(PizzasysMock::fixtureStatus($fixture), PizzasysMock::fixture($fixture));
    }

    // ---- login --------------------------------------------------------------------------------------------------

    public function test_a_successful_login_returns_the_upstream_token(): void
    {
        $this->fakeFixture('login-ok');

        $result = $this->client()->login($this->endpoint, 'agent@test.local', 'secret');

        $this->assertSame(PortalStatus::Ok, $result->status);
        $this->assertTrue($result->isOk());
        $this->assertSame('<token>', $result->token);
        Http::assertSent(fn (Request $request): bool => $request->url() === PizzasysMock::BASE_URL.'/api/v1/auth/login'
            && $request->method() === 'POST'
            && $request->hasHeader('Accept', 'application/json')
            && ! $request->hasHeader('Authorization')
            && $request->data() === ['email' => 'agent@test.local', 'password' => 'secret']);
    }

    public function test_wrong_credentials_are_invalid_for_both_401_and_422(): void
    {
        $this->fakeFixture('login-invalid');
        $this->assertSame(PortalStatus::Invalid, $this->client()->login($this->endpoint, 'agent@test.local', 'x')->status);

        $this->fakeFixture('login-malformed-bad-email');
        $this->assertSame(PortalStatus::Invalid, $this->client()->login($this->endpoint, 'not-an-email', 'x')->status);
    }

    public function test_login_failures_that_are_not_the_users_fault_are_unavailable(): void
    {
        foreach ([500, 502, 503, 429, 404, 302] as $status) {
            $this->fakeStatus($status, 'oops');
            $result = $this->client()->login($this->endpoint, 'a@b.test', 'x');

            $this->assertSame(PortalStatus::Unavailable, $result->status, (string) $status);
            $this->assertNull($result->token);
        }

        $this->fakeStatus(200, '<html>not json</html>');
        $this->assertSame('unexpected_response', $this->client()->login($this->endpoint, 'a@b.test', 'x')->reason);

        $this->fakeStatus(200, ['success' => true, 'data' => []]);
        $this->assertSame(PortalStatus::Unavailable, $this->client()->login($this->endpoint, 'a@b.test', 'x')->status);
    }

    public function test_connection_problems_are_unavailable_and_retried_exactly_once(): void
    {
        $this->failTransport('cURL error 7: Failed to connect', $attempts);

        $result = $this->client()->login($this->endpoint, 'a@b.test', 'x');

        $this->assertSame(PortalStatus::Unavailable, $result->status);
        $this->assertSame('connection', $result->reason);
        $this->assertSame(2, $attempts, 'one retry, no more');
    }

    public function test_a_timeout_and_a_tls_error_get_their_own_reasons(): void
    {
        $this->failTransport('cURL error 28: Operation timed out', $attempts);
        $this->assertSame('timeout', $this->client()->login($this->endpoint, 'a@b.test', 'x')->reason);

        $this->failTransport('cURL error 60: SSL certificate problem', $attempts);
        $this->assertSame('tls', $this->client()->login($this->endpoint, 'a@b.test', 'x')->reason);
    }

    public function test_an_http_error_is_not_retried(): void
    {
        $this->fakeStatus(500, 'boom');

        $this->client()->login($this->endpoint, 'a@b.test', 'x');

        Http::assertSentCount(1);
    }

    public function test_redirects_are_never_followed(): void
    {
        $this->freshHttp()->fake([PizzasysMock::BASE_URL.'/*' => Http::response('', 302, ['Location' => 'https://evil.example/steal'])]);

        $result = $this->client()->verify($this->endpoint, '1|token');

        $this->assertSame(PortalStatus::Unavailable, $result->status);
        Http::assertSentCount(1);
    }

    // ---- token-verify -------------------------------------------------------------------------------------------

    public function test_an_active_token_returns_the_canonical_claims(): void
    {
        $this->fakeFixture('token-verify-active-agent');

        $result = $this->client()->verify($this->endpoint, '4|usertoken');

        $this->assertSame(PortalStatus::Ok, $result->status);
        $this->assertTrue($result->isActive());
        $this->assertSame('4', $result->claims->sub);
        $this->assertSame('Test Agent', $result->claims->name);
        $this->assertSame('agent@test.local', $result->claims->email);
        $this->assertSame([], $result->claims->roles);
        $this->assertSame(['chat.agent'], $result->claims->permissions);
        $this->assertNull($result->claims->exp, 'login tokens never expire upstream');

        Http::assertSent(fn (Request $request): bool => $request->url() === PizzasysMock::BASE_URL.'/api/v1/auth/token-verify'
            && $request->hasHeader('Authorization', 'Bearer '.PizzasysMock::SERVICE_TOKEN)
            && $request->hasHeader('Accept', 'application/json')
            && $request->data() === ['service' => PizzasysMock::SERVICE_NAME, 'token' => '4|usertoken']);
    }

    public function test_roles_and_permissions_of_a_super_admin_are_read_as_they_come(): void
    {
        $this->fakeFixture('token-verify-active-admin');

        $claims = $this->client()->verify($this->endpoint, 't')->claims;

        $this->assertSame(['super-admin'], $claims->roles);
        $this->assertNotContains('chat.admin', $claims->permissions);
        $this->assertContains('manage users', $claims->permissions);
    }

    public function test_an_inactive_token_is_a_normal_200_answer(): void
    {
        $this->fakeFixture('token-verify-inactive');

        $result = $this->client()->verify($this->endpoint, '4|dead');

        $this->assertSame(PortalStatus::Inactive, $result->status);
        $this->assertFalse($result->isActive());
        $this->assertNull($result->claims);
    }

    public function test_service_credential_problems_are_401_and_carry_the_portal_message(): void
    {
        foreach ([
            'token-verify-bad-service-wrong-bearer' => 'The service token is not valid for this service.',
            'token-verify-bad-service-unknown-service' => 'The portal does not know a service with this name.',
            'token-verify-bad-service-expired' => 'The service token has expired.',
            'token-verify-bad-service-inactive' => 'The service is deactivated in the portal.',
            'token-verify-bad-service-missing-bearer' => 'The portal rejected the service credential.',
        ] as $fixture => $message) {
            $this->fakeFixture($fixture);

            $result = $this->client()->verify($this->endpoint, '4|x');

            $this->assertSame(PortalStatus::ServiceRejected, $result->status, $fixture);
            $this->assertSame($message, $result->message, $fixture);
        }
    }

    public function test_the_portals_own_text_is_never_echoed(): void
    {
        $this->fakeStatus(401, ['message' => 'Invalid service token. <script>alert(1)</script> '.PizzasysMock::SERVICE_TOKEN]);

        $result = $this->client()->verify($this->endpoint, '4|x');

        $this->assertSame(PortalStatus::ServiceRejected, $result->status);
        $this->assertSame('The portal rejected the service credential.', $this->client()->probe($this->endpoint)->message, 'only the exact known messages are recognised');
        $this->assertStringNotContainsString('script', (string) $result->message);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, (string) $result->message);

        $this->fakeStatus(401, ['message' => 'Something nobody expected: the database password is hunter2']);
        $this->assertSame('The portal rejected the service credential.', $this->client()->verify($this->endpoint, '4|x')->message);
        $this->assertSame('The portal rejected the service credential.', $this->client()->probe($this->endpoint)->message);

        $this->fakeStatus(401, 'plain text, not json');
        $this->assertSame('The portal rejected the service credential.', $this->client()->verify($this->endpoint, '4|x')->message);
    }

    public function test_a_server_error_a_rate_limit_and_garbage_are_unavailable(): void
    {
        foreach ([500, 503, 429, 404, 403, 422] as $status) {
            $this->fakeStatus($status, ['message' => 'nope']);
            $this->assertSame(PortalStatus::Unavailable, $this->client()->verify($this->endpoint, 'x')->status, (string) $status);
        }

        $this->fakeStatus(200, '<html>maintenance</html>');
        $this->assertSame('unexpected_response', $this->client()->verify($this->endpoint, 'x')->reason);

        $this->fakeStatus(200, ['active' => 'yes']);
        $this->assertSame(PortalStatus::Unavailable, $this->client()->verify($this->endpoint, 'x')->status);

        $this->fakeStatus(200, ['active' => true, 'sub' => '1']); // no user email
        $this->assertSame(PortalStatus::Unavailable, $this->client()->verify($this->endpoint, 'x')->status);
    }

    public function test_a_timeout_while_verifying_is_unavailable(): void
    {
        $this->failTransport('cURL error 28: Operation timed out after 3000 milliseconds', $attempts);

        $result = $this->client()->verify($this->endpoint, 'x');

        $this->assertSame(PortalStatus::Unavailable, $result->status);
        $this->assertSame('timeout', $result->reason);
    }

    // ---- me / logout --------------------------------------------------------------------------------------------

    public function test_me_derives_global_roles_and_permissions_the_way_verify_does(): void
    {
        $this->fakeFixture('me-roleagent');
        $claims = $this->client()->me($this->endpoint, 'tok')->claims;
        $this->assertSame(['chat-agent-role'], $claims->roles);
        $this->assertSame(['chat.agent'], $claims->permissions, 'a permission granted through a global role');

        $this->fakeFixture('me-storeuser');
        $this->assertSame([], $this->client()->me($this->endpoint, 'tok')->claims->permissions, 'store-scoped permissions are not global');

        $this->fakeFixture('me-chatadmin');
        $this->assertSame(['chat.admin'], $this->client()->me($this->endpoint, 'tok')->claims->permissions);
    }

    public function test_me_with_a_dead_token_is_inactive(): void
    {
        $this->fakeFixture('me-unauthenticated');

        $this->assertSame(PortalStatus::Inactive, $this->client()->me($this->endpoint, 'tok')->status);
    }

    public function test_me_is_called_with_the_users_own_token_not_the_service_credential(): void
    {
        $this->fakeFixture('me-agent');

        $this->client()->me($this->endpoint, '4|usertoken');

        Http::assertSent(fn (Request $request): bool => $request->method() === 'GET'
            && $request->url() === PizzasysMock::BASE_URL.'/api/v1/auth/me'
            && $request->hasHeader('Authorization', 'Bearer 4|usertoken'));
    }

    public function test_logout_is_best_effort_and_never_throws(): void
    {
        $this->fakeFixture('logout-ok');
        $this->assertTrue($this->client()->logout($this->endpoint, '4|tok'));
        Http::assertSent(fn (Request $request): bool => $request->url() === PizzasysMock::BASE_URL.'/api/v1/auth/logout' && $request->hasHeader('Authorization', 'Bearer 4|tok'));

        $this->failTransport('down', $attempts);
        $this->assertFalse($this->client()->logout($this->endpoint, '4|tok'));
        $this->assertSame(1, $attempts, 'logout is not retried');

        $this->fakeStatus(500, 'x');
        $this->assertFalse($this->client()->logout($this->endpoint, '4|tok'));
    }

    // ---- probe --------------------------------------------------------------------------------------------------

    public function test_the_probe_accepts_a_working_service_credential(): void
    {
        $this->fakeFixture('token-verify-inactive');

        $probe = $this->client()->probe($this->endpoint);

        $this->assertTrue($probe->reachable);
        $this->assertTrue($probe->serviceCredentialAccepted);
        $this->assertNotNull($probe->latencyMs);
        $this->assertNull($probe->message);
        Http::assertSent(fn (Request $request): bool => str_ends_with($request->url(), '/auth/token-verify') && is_string($request['token']) && $request['token'] !== '');
    }

    public function test_the_probe_reports_a_rejected_service_credential(): void
    {
        $this->fakeFixture('token-verify-bad-service-wrong-bearer');

        $probe = $this->client()->probe($this->endpoint);

        $this->assertTrue($probe->reachable);
        $this->assertFalse($probe->serviceCredentialAccepted);
        $this->assertSame('The service token is not valid for this service.', $probe->message);
    }

    public function test_the_probe_reports_an_unreachable_portal_without_leaking_transport_details(): void
    {
        $this->failTransport('cURL error 6: Could not resolve host: secret-internal-host.corp', $attempts);

        $probe = $this->client()->probe($this->endpoint);

        $this->assertFalse($probe->reachable);
        $this->assertFalse($probe->serviceCredentialAccepted);
        $this->assertNull($probe->latencyMs);
        $this->assertStringNotContainsString('secret-internal-host', (string) $probe->message);
    }

    public function test_the_probe_tells_a_wrong_address_from_a_down_portal(): void
    {
        $this->fakeStatus(404, 'Not found');
        $wrongPrefix = $this->client()->probe($this->endpoint);
        $this->assertTrue($wrongPrefix->reachable);
        $this->assertFalse($wrongPrefix->serviceCredentialAccepted);
        $this->assertStringContainsString('404', (string) $wrongPrefix->message);

        $this->fakeStatus(502, 'Bad gateway');
        $this->assertFalse($this->client()->probe($this->endpoint)->reachable);
    }

    public function test_the_probe_refuses_a_server_that_accepts_a_made_up_token(): void
    {
        $this->fakeFixture('token-verify-active-agent');

        $probe = $this->client()->probe($this->endpoint);

        $this->assertFalse($probe->serviceCredentialAccepted);
        $this->assertStringContainsString('not a pizzasys', (string) $probe->message);
    }

    public function test_the_api_prefix_and_trailing_slashes_are_honoured(): void
    {
        $endpoint = new PizzasysEndpoint('production', 'https://auth.example.test/', '/v2/', 'svc', 'token');

        $this->assertSame('https://auth.example.test/v2/auth/login', $endpoint->url('/auth/login'));
    }

    public function test_the_endpoint_never_shows_its_token_when_dumped(): void
    {
        $dump = print_r($this->endpoint, true).var_export($this->endpoint, true);

        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, print_r($this->endpoint, true));
        $this->assertStringContainsString('[redacted]', print_r($this->endpoint, true));
        unset($dump);
    }
}
