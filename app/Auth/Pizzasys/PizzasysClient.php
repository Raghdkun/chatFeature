<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalLoginResult;
use App\Auth\Pizzasys\Results\PortalProbeResult;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Pizzasys\Results\PortalVerifyResult;
use App\Domain\Settings\SettingsRepository;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Str;
use SensitiveParameter;
use Throwable;

/**
 * The raw HTTP side of the pizzasys auth portal (docs/pizzasys-findings.md): login, token-verify, me, logout
 * and a service-credential probe. Stateless: callers pass the endpoint (decrypted service credential included).
 *
 * Contract with the portal, as verified empirically:
 *  - always `Accept: application/json`; a bad USER token is HTTP 200 `{"active":false}`;
 *  - a bad SERVICE credential is HTTP 401 (never 403);
 *  - redirects are never followed (the bearer token must not follow a Location header elsewhere).
 *
 * Never logs request or response bodies. Transport problems are reduced to a reason code
 * ({@see PortalFailure}); raw exception text is dropped.
 */
final class PizzasysClient
{
    public const CONNECT_TIMEOUT_SECONDS = 2;

    /** Best-effort calls (upstream logout) must never hold a request up. */
    public const LOGOUT_TIMEOUT_SECONDS = 2;

    public function __construct(
        private readonly HttpFactory $http,
        private readonly SettingsRepository $settings,
    ) {}

    /**
     * `POST /auth/login`. 401 and 422 both mean "these credentials are not accepted".
     */
    public function login(PizzasysEndpoint $env, string $email, #[SensitiveParameter] string $password): PortalLoginResult
    {
        try {
            $response = $this->request($env, null, $this->loginTimeout())
                ->post($env->url('/auth/login'), ['email' => $email, 'password' => $password]);
        } catch (ConnectionException $exception) {
            return PortalLoginResult::unavailable($this->reasonFor($exception));
        }

        $status = $response->status();

        if ($status === 401 || $status === 422) {
            return PortalLoginResult::invalid();
        }

        if ($status === 429) {
            return PortalLoginResult::unavailable(PortalFailure::RATE_LIMITED);
        }

        if ($status !== 200) {
            return PortalLoginResult::unavailable(PortalFailure::http($status));
        }

        $token = $this->json($response)['data']['token'] ?? null;

        return is_string($token) && $token !== ''
            ? PortalLoginResult::ok($token)
            : PortalLoginResult::unavailable(PortalFailure::UNEXPECTED_RESPONSE);
    }

    /**
     * `POST /auth/token-verify` with the service bearer. HTTP 200 `active:false` is a normal answer
     * (the user token is dead); HTTP 401 means our service credential is not accepted.
     */
    public function verify(PizzasysEndpoint $env, #[SensitiveParameter] string $userToken): PortalVerifyResult
    {
        try {
            $response = $this->request($env, $env->serviceToken, $this->verifyTimeout())
                ->post($env->url('/auth/token-verify'), ['service' => $env->serviceName, 'token' => $userToken]);
        } catch (ConnectionException $exception) {
            return PortalVerifyResult::unavailable($this->reasonFor($exception));
        }

        $status = $response->status();

        if ($status === 401) {
            $message = $this->json($response)['message'] ?? null;

            return PortalVerifyResult::serviceRejected(PortalFailure::serviceRejection(is_string($message) ? $message : null));
        }

        if ($status === 429) {
            return PortalVerifyResult::unavailable(PortalFailure::RATE_LIMITED);
        }

        if ($status !== 200) {
            return PortalVerifyResult::unavailable(PortalFailure::http($status));
        }

        $body = $this->json($response);

        if (! array_key_exists('active', $body) || ! is_bool($body['active'])) {
            return PortalVerifyResult::unavailable(PortalFailure::UNEXPECTED_RESPONSE);
        }

        if ($body['active'] === false) {
            return PortalVerifyResult::inactive();
        }

        $claims = PortalClaims::fromVerifyPayload($body);

        return $claims !== null
            ? PortalVerifyResult::active($claims)
            : PortalVerifyResult::unavailable(PortalFailure::UNEXPECTED_RESPONSE);
    }

    /**
     * `GET /auth/me` with the USER token: the fallback when the service credential is rejected.
     */
    public function me(PizzasysEndpoint $env, #[SensitiveParameter] string $userToken): PortalVerifyResult
    {
        try {
            $response = $this->request($env, $userToken, $this->verifyTimeout())->get($env->url('/auth/me'));
        } catch (ConnectionException $exception) {
            return PortalVerifyResult::unavailable($this->reasonFor($exception));
        }

        $status = $response->status();

        if ($status === 401) {
            return PortalVerifyResult::inactive();
        }

        if ($status === 429) {
            return PortalVerifyResult::unavailable(PortalFailure::RATE_LIMITED);
        }

        if ($status !== 200) {
            return PortalVerifyResult::unavailable(PortalFailure::http($status));
        }

        $claims = PortalClaims::fromMePayload($this->json($response));

        return $claims !== null
            ? PortalVerifyResult::active($claims)->viaUserToken()
            : PortalVerifyResult::unavailable(PortalFailure::UNEXPECTED_RESPONSE);
    }

    /**
     * Best-effort `POST /auth/logout`: deletes only THIS user token upstream. Never throws, never retries.
     */
    public function logout(PizzasysEndpoint $env, #[SensitiveParameter] string $userToken): bool
    {
        try {
            return $this->request($env, $userToken, self::LOGOUT_TIMEOUT_SECONDS, retry: false)
                ->post($env->url('/auth/logout'))
                ->successful();
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * Checks the service credential and measures latency by verifying a made-up token, which a healthy
     * portal answers with HTTP 200 `{"active":false}`.
     */
    public function probe(PizzasysEndpoint $env): PortalProbeResult
    {
        $started = hrtime(true);
        $result = $this->verify($env, '0|'.Str::random(48));
        $latency = (int) round((hrtime(true) - $started) / 1_000_000);

        return match (true) {
            $result->status === PortalStatus::Inactive => new PortalProbeResult(true, true, $latency),
            $result->status === PortalStatus::ServiceRejected => new PortalProbeResult(true, false, $latency, $result->message ?? PortalFailure::serviceRejection(null), 'service_rejected'),
            $result->isActive() => new PortalProbeResult(true, false, $latency, __('The portal accepted a made-up token. This is not a pizzasys auth portal.'), PortalFailure::UNEXPECTED_RESPONSE),
            PortalFailure::isUnreachable($result->reason) => new PortalProbeResult(false, false, null, PortalFailure::message($result->reason), $result->reason),
            default => new PortalProbeResult(true, false, $latency, PortalFailure::message($result->reason), $result->reason),
        };
    }

    private function request(PizzasysEndpoint $env, #[SensitiveParameter] ?string $bearer, float|int $timeout, bool $retry = true): PendingRequest
    {
        $request = $this->http->acceptJson()
            ->connectTimeout(self::CONNECT_TIMEOUT_SECONDS)
            ->timeout($timeout)
            ->withoutRedirecting();

        if ($bearer !== null) {
            $request = $request->withToken($bearer);
        }

        if (! $env->verifyTls) {
            $request = $request->withoutVerifying();
        }

        // One retry, and only when the connection itself failed (never for an HTTP answer; a 3xx hands the callback no exception).
        return $retry
            ? $request->retry(2, 150, fn (?Throwable $exception): bool => $exception instanceof ConnectionException, throw: false)
            : $request;
    }

    /**
     * @return array<array-key, mixed>
     */
    private function json(Response $response): array
    {
        $decoded = $response->json();

        return is_array($decoded) ? $decoded : [];
    }

    private function reasonFor(ConnectionException $exception): string
    {
        $message = strtolower($exception->getMessage());

        return match (true) {
            str_contains($message, 'timed out') || str_contains($message, 'timeout') => PortalFailure::TIMEOUT,
            str_contains($message, 'ssl') || str_contains($message, 'certificate') => PortalFailure::TLS,
            default => PortalFailure::CONNECTION,
        };
    }

    private function verifyTimeout(): int
    {
        return max(1, $this->settings->int('auth.pizzasys.verify_timeout_seconds', 3));
    }

    /** bcrypt on the portal side makes a login slower than a verify. */
    private function loginTimeout(): int
    {
        return max(6, $this->verifyTimeout() * 2);
    }
}
