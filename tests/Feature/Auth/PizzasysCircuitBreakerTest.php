<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\PortalGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

class PizzasysCircuitBreakerTest extends TestCase
{
    use RefreshDatabase;

    private PizzasysCircuitBreaker $breaker;

    protected function setUp(): void
    {
        parent::setUp();

        $this->breaker = app(PizzasysCircuitBreaker::class);
    }

    private function recordFailures(string $environment, int $times): void
    {
        for ($i = 0; $i < $times; $i++) {
            $this->breaker->recordFailure($environment);
        }
    }

    public function test_it_starts_closed(): void
    {
        $this->assertFalse($this->breaker->isOpen('production'));
        $this->assertSame(0, $this->breaker->failures('production'));
    }

    public function test_five_failures_within_thirty_seconds_open_it(): void
    {
        $this->recordFailures('production', 4);
        $this->assertFalse($this->breaker->isOpen('production'));
        $this->assertSame(4, $this->breaker->failures('production'));

        $this->breaker->recordFailure('production');

        $this->assertTrue($this->breaker->isOpen('production'));
    }

    public function test_failures_spread_over_more_than_thirty_seconds_do_not_open_it(): void
    {
        $this->recordFailures('production', 3);
        $this->travel(31)->seconds();
        $this->recordFailures('production', 3);

        $this->assertFalse($this->breaker->isOpen('production'));
    }

    public function test_it_stays_open_for_thirty_seconds_then_closes(): void
    {
        $this->recordFailures('production', 5);
        $this->assertTrue($this->breaker->isOpen('production'));

        $this->travel(29)->seconds();
        $this->assertTrue($this->breaker->isOpen('production'));

        $this->travel(2)->seconds();
        $this->assertFalse($this->breaker->isOpen('production'));
        $this->assertSame(0, $this->breaker->failures('production'), 'a fresh window starts after it closes');
    }

    public function test_a_success_resets_the_failure_count(): void
    {
        $this->recordFailures('production', 4);
        $this->breaker->recordSuccess('production');
        $this->recordFailures('production', 4);

        $this->assertFalse($this->breaker->isOpen('production'));
    }

    public function test_each_environment_has_its_own_circuit(): void
    {
        $this->recordFailures('production', 5);

        $this->assertTrue($this->breaker->isOpen('production'));
        $this->assertFalse($this->breaker->isOpen('testing'));
    }

    public function test_reset_closes_it_immediately(): void
    {
        $this->recordFailures('production', 5);
        $this->breaker->reset('production');

        $this->assertFalse($this->breaker->isOpen('production'));
    }

    public function test_an_open_circuit_stops_calling_the_portal_at_all(): void
    {
        $portal = PizzasysMock::make()->outage('connection')->fake();
        $endpoint = new PizzasysEndpoint('production', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);
        $gateway = app(PortalGateway::class);

        // every failed verify is retried once on the connection error, so 5 failures = 10 HTTP attempts
        for ($i = 0; $i < 5; $i++) {
            $this->assertSame('connection', $gateway->verify($endpoint, 'token-'.$i)->reason);
        }
        $this->assertSame(10, $portal->calls('token-verify'));
        $this->assertTrue($this->breaker->isOpen('production'));

        $this->assertSame('circuit_open', $gateway->verify($endpoint, 'another')->reason);
        $this->assertSame('circuit_open', $gateway->login($endpoint, 'a@b.test', 'x')->reason);
        $this->assertSame(10, $portal->calls('token-verify'));
        $this->assertSame(0, $portal->calls('login'));

        $this->travel(31)->seconds();
        $gateway->verify($endpoint, 'later');
        $this->assertSame(12, $portal->calls('token-verify'));
    }

    public function test_http_answers_never_count_as_failures_except_server_errors(): void
    {
        $endpoint = new PizzasysEndpoint('production', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);
        $gateway = app(PortalGateway::class);

        $portal = PizzasysMock::make()->fake();
        for ($i = 0; $i < 8; $i++) {
            $gateway->verify($endpoint, 'dead-'.$i);
        }
        $this->assertFalse($this->breaker->isOpen('production'), 'active:false is a normal answer');

        $portal->rejectServiceCredential();
        for ($i = 0; $i < 8; $i++) {
            $gateway->verify($endpoint, 'x-'.$i, userTokenFallback: false);
        }
        $this->assertFalse($this->breaker->isOpen('production'), 'a rejected credential is not an outage');

        $portal->acceptServiceCredential()->outage('server_error');
        $this->travel(2)->minutes(); // the "credential rejected" finding has expired
        for ($i = 0; $i < 5; $i++) {
            $gateway->verify($endpoint, 'e-'.$i);
        }
        $this->assertTrue($this->breaker->isOpen('production'));
    }
}
