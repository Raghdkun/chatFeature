<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\PortalGateway;
use App\Auth\Pizzasys\PortalHealth;
use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Pizzasys\VerifyCache;
use Illuminate\Cache\ArrayStore;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;
use ReflectionProperty;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * The resilient layer in front of the portal: verify cache (TTL, negative cache, single-flight, hash keys), the
 * "service credential rejected" handling and the /auth/me fallback.
 */
class PortalGatewayTest extends TestCase
{
    use RefreshDatabase;

    private PizzasysEndpoint $endpoint;

    private PizzasysMock $portal;

    private string $token;

    protected function setUp(): void
    {
        parent::setUp();

        $this->endpoint = new PizzasysEndpoint('production', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);
        $this->portal = PizzasysMock::make()->user('agent@test.local', 'pw', 'agent')->fake();
        $this->token = $this->portal->tokenFor('agent@test.local');
    }

    private function gateway(): PortalGateway
    {
        return app(PortalGateway::class);
    }

    public function test_a_verified_token_is_served_from_the_cache_until_the_ttl_expires(): void
    {
        $first = $this->gateway()->verify($this->endpoint, $this->token);
        $second = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertFalse($first->fromCache);
        $this->assertTrue($second->fromCache);
        $this->assertTrue($second->isActive());
        $this->assertSame($first->claims->toArray(), $second->claims->toArray());
        $this->assertSame(1, $this->portal->calls('token-verify'));

        $this->travel(59)->seconds();
        $this->gateway()->verify($this->endpoint, $this->token);
        $this->assertSame(1, $this->portal->calls('token-verify'));

        $this->travel(2)->seconds();
        $this->assertFalse($this->gateway()->verify($this->endpoint, $this->token)->fromCache);
        $this->assertSame(2, $this->portal->calls('token-verify'));
    }

    public function test_the_ttl_follows_the_setting(): void
    {
        settings()->set('auth.pizzasys.verify_ttl_seconds', 15);
        $this->gateway()->verify($this->endpoint, $this->token);

        $this->travel(16)->seconds();
        $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertSame(2, $this->portal->calls('token-verify'));
    }

    public function test_an_inactive_answer_is_cached_for_only_fifteen_seconds(): void
    {
        $this->portal->revoke('agent@test.local');

        $first = $this->gateway()->verify($this->endpoint, $this->token);
        $second = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertSame(PortalStatus::Inactive, $first->status);
        $this->assertSame(PortalStatus::Inactive, $second->status);
        $this->assertTrue($second->fromCache);
        $this->assertSame(1, $this->portal->calls('token-verify'));

        $this->travel(16)->seconds();
        $this->gateway()->verify($this->endpoint, $this->token);
        $this->assertSame(2, $this->portal->calls('token-verify'));
    }

    public function test_unavailable_answers_are_never_cached(): void
    {
        $this->portal->outage('server_error');
        $this->gateway()->verify($this->endpoint, $this->token);
        $this->gateway()->verify($this->endpoint, $this->token);
        $this->assertSame(2, $this->portal->calls('token-verify'));

        $this->portal->recover();
        $this->assertTrue($this->gateway()->verify($this->endpoint, $this->token)->isActive());
    }

    public function test_fresh_skips_the_cache_read_but_refills_it(): void
    {
        $this->gateway()->verify($this->endpoint, $this->token);
        $this->portal->claims('agent@test.local', [], ['chat.admin']);

        $fresh = $this->gateway()->verify($this->endpoint, $this->token, fresh: true);

        $this->assertFalse($fresh->fromCache);
        $this->assertSame(['chat.admin'], $fresh->claims->permissions);
        $this->assertSame(['chat.admin'], $this->gateway()->verify($this->endpoint, $this->token)->claims->permissions);
    }

    public function test_the_cache_never_contains_the_token_itself(): void
    {
        $this->gateway()->verify($this->endpoint, $this->token);

        $store = Cache::getStore();
        $this->assertInstanceOf(ArrayStore::class, $store);
        $storage = (new ReflectionProperty($store, 'storage'))->getValue($store);
        $dump = serialize($storage);

        $this->assertStringNotContainsString($this->token, $dump);
        $this->assertStringNotContainsString(explode('|', $this->token)[1], $dump);
        $this->assertStringContainsString(hash('sha256', $this->token), $dump);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $dump);
    }

    public function test_flushing_everything_drops_every_cached_answer(): void
    {
        $this->gateway()->verify($this->endpoint, $this->token);
        app(VerifyCache::class)->flushAll();

        $this->assertFalse($this->gateway()->verify($this->endpoint, $this->token)->fromCache);
        $this->assertSame(2, $this->portal->calls('token-verify'));
    }

    public function test_the_same_token_in_another_environment_has_its_own_cache_entry(): void
    {
        $other = new PizzasysEndpoint('testing', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, PizzasysMock::SERVICE_TOKEN);

        $this->gateway()->verify($this->endpoint, $this->token);
        $this->assertFalse($this->gateway()->verify($other, $this->token)->fromCache);
    }

    // ---- single flight -----------------------------------------------------------------------------------------

    public function test_a_concurrent_request_waits_for_the_leader_and_reuses_its_answer(): void
    {
        $cache = app(VerifyCache::class);
        $leader = $cache->lockFor('production', $this->token);
        $this->assertTrue($leader->get(), 'another request is verifying this token right now');

        Sleep::fake(syncWithCarbon: true);
        Sleep::whenFakingSleep(function () use ($cache, $leader): void {
            // while we wait, the leader finishes: it fills the cache and releases the lock
            $cache->putActive('production', $this->token, PortalClaims::fromVerifyPayload(PizzasysMock::fixture('token-verify-active-agent')));
            $leader->release();
        });

        $result = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertTrue($result->isActive());
        $this->assertTrue($result->fromCache);
        $this->assertSame(0, $this->portal->calls('token-verify'), 'no second upstream call');
    }

    public function test_a_stuck_leader_does_not_starve_the_waiters(): void
    {
        $leader = app(VerifyCache::class)->lockFor('production', $this->token);
        $this->assertTrue($leader->get());
        Sleep::fake(syncWithCarbon: true);

        $result = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertTrue($result->isActive());
        $this->assertSame(1, $this->portal->calls('token-verify'), 'after the wait the request verifies itself');
    }

    public function test_the_verify_lock_is_released_after_the_call(): void
    {
        $this->gateway()->verify($this->endpoint, $this->token);

        $lock = app(VerifyCache::class)->lockFor('production', $this->token);
        $this->assertTrue($lock->get());
        $lock->release();
    }

    // ---- service credential rejected ---------------------------------------------------------------------------

    public function test_a_rejected_service_credential_falls_back_to_me_for_existing_sessions(): void
    {
        $this->portal->rejectServiceCredential('Service token expired.');

        $result = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertTrue($result->isActive());
        $this->assertTrue($result->viaUserToken);
        $this->assertSame(['chat.agent'], $result->claims->permissions);
        $this->assertSame(1, $this->portal->calls('me'));

        $rejection = app(PortalHealth::class)->serviceRejection('production');
        $this->assertSame('The service token has expired.', $rejection['message']);
        $this->assertSame('degraded', app(PortalHealth::class)->status('production'));
    }

    public function test_while_the_credential_is_known_to_be_rejected_the_portal_is_not_asked_again_for_a_minute(): void
    {
        $this->portal->rejectServiceCredential();
        $this->gateway()->verify($this->endpoint, $this->token, fresh: true);
        $this->gateway()->verify($this->endpoint, $this->token, fresh: true);
        $this->gateway()->verify($this->endpoint, $this->token, fresh: true);

        $this->assertSame(1, $this->portal->calls('token-verify'), 'the 401 is remembered');
        $this->assertSame(3, $this->portal->calls('me'));

        // fixed on the portal side: it is noticed once the finding expires
        $this->portal->acceptServiceCredential();
        $this->travel(61)->seconds();
        $result = $this->gateway()->verify($this->endpoint, $this->token, fresh: true);

        $this->assertFalse($result->viaUserToken);
        $this->assertSame(2, $this->portal->calls('token-verify'));
        $this->assertNull(app(PortalHealth::class)->serviceRejection('production'));
        $this->assertSame('ok', app(PortalHealth::class)->status('production'));
    }

    public function test_new_logins_do_not_use_the_me_fallback(): void
    {
        $this->portal->rejectServiceCredential();

        $result = $this->gateway()->verify($this->endpoint, $this->token, fresh: true, userTokenFallback: false);

        $this->assertSame(PortalStatus::ServiceRejected, $result->status);
        $this->assertSame(0, $this->portal->calls('me'));
    }

    public function test_the_me_fallback_with_a_dead_token_is_inactive(): void
    {
        $this->portal->rejectServiceCredential();
        $this->portal->revoke('agent@test.local');

        $result = $this->gateway()->verify($this->endpoint, $this->token);

        $this->assertSame(PortalStatus::Inactive, $result->status);
    }

    public function test_the_me_fallback_with_the_portal_down_is_unavailable(): void
    {
        $this->portal->rejectServiceCredential();
        $this->gateway()->verify($this->endpoint, $this->token); // marks the finding

        $this->portal->outage('connection');
        $result = $this->gateway()->verify($this->endpoint, $this->token, fresh: true);

        $this->assertSame(PortalStatus::Unavailable, $result->status);
    }

    public function test_logging_out_closes_the_upstream_token_and_forgets_the_cached_answer(): void
    {
        $this->gateway()->verify($this->endpoint, $this->token);

        $this->gateway()->logout($this->endpoint, $this->token);

        $this->assertSame(1, $this->portal->calls('logout'));
        $this->assertSame(PortalStatus::Inactive, $this->gateway()->verify($this->endpoint, $this->token)->status);
    }

    public function test_health_summarises_what_was_observed(): void
    {
        $health = app(PortalHealth::class);
        $this->assertSame('unknown', $health->status('production'));
        $this->assertNull($health->lastVerifyAt('production'));

        $this->gateway()->verify($this->endpoint, $this->token);
        $this->assertSame('ok', $health->status('production'));
        $this->assertNotNull($health->lastVerifyAt('production'));

        $this->portal->outage('connection');
        $this->gateway()->verify($this->endpoint, 'other-token');
        $this->assertSame('degraded', $health->status('production'));

        $this->portal->recover();
        $this->gateway()->verify($this->endpoint, 'another-token');
        $this->assertSame('ok', $health->status('production'), 'a later success clears the failure');
    }

    // ---- the circuit breaker only counts a portal that is down ----------------------------------------------------------

    /**
     * Every call answers like this, whatever the path.
     *
     * @param  array<string, mixed>|string  $body
     */
    private function everyCallAnswers(int $status, array|string $body = []): void
    {
        Http::swap(new Factory);
        Http::fake([PizzasysMock::BASE_URL.'/*' => Http::response($body, $status)]);
    }

    private function breaker(): PizzasysCircuitBreaker
    {
        return app(PizzasysCircuitBreaker::class);
    }

    public function test_a_portal_that_keeps_saying_429_never_opens_the_circuit(): void
    {
        $this->everyCallAnswers(429, ['message' => 'Too Many Attempts.']);

        for ($i = 0; $i < 20; $i++) {
            $login = $this->gateway()->login($this->endpoint, "u{$i}@example.test", 'pw');
            $this->assertSame(PortalStatus::Unavailable, $login->status);
            $this->assertSame('rate_limited', $login->reason);
        }

        $this->assertFalse($this->breaker()->isOpen('production'));
        $this->assertSame(0, $this->breaker()->failures('production'));
        $this->assertNotSame('down', app(PortalHealth::class)->status('production'));
    }

    public function test_a_login_spray_of_wrong_passwords_never_opens_the_circuit(): void
    {
        for ($i = 0; $i < 20; $i++) {
            $this->assertSame(PortalStatus::Invalid, $this->gateway()->login($this->endpoint, 'agent@test.local', "wrong-{$i}")->status);
        }

        $this->assertFalse($this->breaker()->isOpen('production'));
        $this->assertSame(PortalStatus::Ok, $this->gateway()->verify($this->endpoint, $this->token)->status, 'sessions keep being verified normally');
    }

    public function test_other_4xx_answers_and_unreadable_answers_do_not_count_either(): void
    {
        foreach ([[403, ['message' => 'Forbidden']], [404, 'Not found'], [418, []], [200, '<html>Maintenance</html>']] as [$status, $body]) {
            $this->everyCallAnswers($status, $body);

            for ($i = 0; $i < 8; $i++) {
                $this->gateway()->login($this->endpoint, 'a@example.test', 'pw');
                $this->gateway()->verify($this->endpoint, $this->token.$i, fresh: true);
            }

            $this->assertFalse($this->breaker()->isOpen('production'), "HTTP {$status}");
            $this->assertSame(0, $this->breaker()->failures('production'), "HTTP {$status}");
        }
    }

    public function test_429_on_verify_and_on_the_me_fallback_does_not_count(): void
    {
        $this->everyCallAnswers(429);

        for ($i = 0; $i < 10; $i++) {
            $this->gateway()->verify($this->endpoint, $this->token.$i, fresh: true);
        }

        $this->assertFalse($this->breaker()->isOpen('production'));
    }

    public function test_connect_errors_timeouts_tls_failures_and_5xx_still_open_the_circuit(): void
    {
        foreach (['connection', 'timeout', 'tls', 'server_error'] as $kind) {
            $this->breaker()->reset('production');
            $this->portal->outage($kind);

            for ($i = 0; $i < PizzasysCircuitBreaker::FAILURE_THRESHOLD; $i++) {
                $this->gateway()->login($this->endpoint, 'a@example.test', 'pw');
            }

            $this->assertTrue($this->breaker()->isOpen('production'), $kind);
        }
    }

    public function test_a_rate_limited_answer_in_between_does_not_hide_a_real_outage_nor_cause_one(): void
    {
        $this->portal->outage('connection');
        for ($i = 0; $i < 3; $i++) {
            $this->gateway()->login($this->endpoint, 'a@example.test', 'pw');
        }
        $this->assertSame(3, $this->breaker()->failures('production'));

        $this->portal->recover();
        $this->assertSame(PortalStatus::Invalid, $this->gateway()->login($this->endpoint, 'nobody@example.test', 'pw')->status);

        $this->assertSame(0, $this->breaker()->failures('production'), 'an answer from the portal proves it is up');
    }

    public function test_the_failure_classes(): void
    {
        foreach (['timeout', 'connection', 'tls', 'http_500', 'http_503', null] as $reason) {
            $this->assertTrue(PortalFailure::countsAgainstBreaker($reason), (string) $reason);
        }

        foreach (['rate_limited', 'unexpected_response', 'circuit_open', 'not_configured', 'blocked', 'http_400', 'http_401', 'http_403', 'http_404', 'http_422', 'http_429'] as $reason) {
            $this->assertFalse(PortalFailure::countsAgainstBreaker($reason), $reason);
        }
    }
}
