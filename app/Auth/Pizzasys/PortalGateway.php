<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalLoginResult;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Pizzasys\Results\PortalVerifyResult;
use Illuminate\Contracts\Cache\LockTimeoutException;
use SensitiveParameter;

/**
 * The resilient way the application talks to the portal: {@see PizzasysClient} plus the circuit breaker, the verify
 * cache (positive TTL, 15 s negative cache, single-flight) and the health observations.
 *
 * Used by the driver at runtime. The setup wizard and the connection tests call the raw client instead, because they
 * must see the portal's real answer every time.
 */
final class PortalGateway
{
    public function __construct(
        private readonly PizzasysClient $client,
        private readonly PizzasysCircuitBreaker $breaker,
        private readonly VerifyCache $cache,
        private readonly PortalHealth $health,
    ) {}

    public function login(PizzasysEndpoint $env, string $email, #[SensitiveParameter] string $password): PortalLoginResult
    {
        if ($this->breaker->isOpen($env->key)) {
            return PortalLoginResult::unavailable(PortalFailure::CIRCUIT_OPEN);
        }

        $result = $this->client->login($env, $email, $password);

        if ($result->status === PortalStatus::Unavailable) {
            $this->breaker->recordFailure($env->key);
            $this->health->markFailure($env->key, (string) $result->reason);
        } else {
            $this->breaker->recordSuccess($env->key);
        }

        return $result;
    }

    /**
     * Is this user token still good, and what does the portal say about its owner?
     *
     * @param  bool  $fresh  Skip the cache read (identity marked stale) but still refill it.
     * @param  bool  $userTokenFallback  When our service credential is rejected, ask `/auth/me` with the user's own
     *                                   token instead of failing. Sessions use it; new logins do not (fail closed).
     */
    public function verify(PizzasysEndpoint $env, #[SensitiveParameter] string $token, bool $fresh = false, bool $userTokenFallback = true): PortalVerifyResult
    {
        if (! $fresh && ($cached = $this->cache->get($env->key, $token)) !== null) {
            return $cached;
        }

        if ($this->health->serviceRejection($env->key) !== null) {
            return $this->rejected($env, $token, null, $userTokenFallback);
        }

        if ($this->breaker->isOpen($env->key)) {
            return PortalVerifyResult::unavailable(PortalFailure::CIRCUIT_OPEN);
        }

        $lock = $this->cache->lockFor($env->key, $token);
        $held = $lock->get();

        if (! $held) {
            // Another request is verifying this very token: wait for its answer instead of asking again.
            try {
                $lock->block(PizzasysClient::CONNECT_TIMEOUT_SECONDS + 3);
                $held = true;
            } catch (LockTimeoutException) {
                $held = false;
            }

            if ($held && ($cached = $this->cache->get($env->key, $token)) !== null) {
                $lock->release();

                return $cached;
            }
        }

        try {
            return $this->callPortal($env, $token, $userTokenFallback);
        } finally {
            if ($held) {
                $lock->release();
            }
        }
    }

    /** Best-effort upstream logout of THIS token. Never throws. */
    public function logout(PizzasysEndpoint $env, #[SensitiveParameter] string $token): void
    {
        if (! $this->breaker->isOpen($env->key)) {
            $this->client->logout($env, $token);
        }
        $this->cache->forget($env->key, $token);
    }

    /** Forget the cached answer of one token (its session ended or changed). */
    public function forget(string $environment, #[SensitiveParameter] string $token): void
    {
        $this->cache->forget($environment, $token);
    }

    private function callPortal(PizzasysEndpoint $env, #[SensitiveParameter] string $token, bool $userTokenFallback): PortalVerifyResult
    {
        $result = $this->client->verify($env, $token);

        switch ($result->status) {
            case PortalStatus::Ok:
                if ($result->claims !== null) {
                    $this->cache->putActive($env->key, $token, $result->claims);
                }
                $this->observeReachable($env);
                $this->health->clearServiceRejected($env->key);

                return $result;

            case PortalStatus::Inactive:
                $this->cache->putInactive($env->key, $token);
                $this->observeReachable($env);

                return $result;

            case PortalStatus::ServiceRejected:
                // The portal answered, so it is reachable; what is wrong is our service credential.
                $this->breaker->recordSuccess($env->key);
                $this->health->markServiceRejected($env->key, $result->message);

                return $this->rejected($env, $token, $result->message, $userTokenFallback);

            default:
                $this->breaker->recordFailure($env->key);
                $this->health->markFailure($env->key, (string) $result->reason);

                return $result;
        }
    }

    /**
     * The portal said (or recently said) "unknown service / invalid or expired service token".
     */
    private function rejected(PizzasysEndpoint $env, #[SensitiveParameter] string $token, ?string $message, bool $userTokenFallback): PortalVerifyResult
    {
        if (! $userTokenFallback) {
            return PortalVerifyResult::serviceRejected($message);
        }

        $me = $this->client->me($env, $token);

        if ($me->status === PortalStatus::Unavailable) {
            $this->breaker->recordFailure($env->key);
            $this->health->markFailure($env->key, (string) $me->reason);

            return $me;
        }

        $this->breaker->recordSuccess($env->key);

        if ($me->isActive() && $me->claims !== null) {
            $this->cache->putActive($env->key, $token, $me->claims);
        } elseif ($me->status === PortalStatus::Inactive) {
            $this->cache->putInactive($env->key, $token);
        }

        return $me->viaUserToken();
    }

    private function observeReachable(PizzasysEndpoint $env): void
    {
        $this->breaker->recordSuccess($env->key);
        $this->health->markOk($env->key);
    }
}
