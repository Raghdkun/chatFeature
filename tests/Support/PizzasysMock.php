<?php

namespace Tests\Support;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use PHPUnit\Framework\Assert;

/**
 * A stateful, in-process stand-in for the pizzasys auth portal, built on `Http::fake` and the real response samples in
 * `tests/fixtures/pizzasys` (captured from a local throwaway portal, secrets redacted).
 *
 * Behaviour copied from the real portal (docs/pizzasys-findings.md): a bad USER token is HTTP 200 `active:false`, a bad
 * SERVICE credential is HTTP 401 with a message, login failures are 401 / 422, `logout` kills only the presented token.
 *
 *   $portal = PizzasysMock::make()->user('agent@test.local', 'secret', 'agent')->fake();
 *   $portal->revoke('agent@test.local');            // the token dies upstream
 *   $portal->outage('timeout');                      // every call times out
 */
final class PizzasysMock
{
    public const BASE_URL = 'https://auth.example.test';

    public const SERVICE_NAME = 'pne-chat';

    public const SERVICE_TOKEN = 'svc-test-token-0123456789abcdef';

    /** @var array<string, array{password: string, profile: string, tokens: list<string>, id: string, name: string, claims: array{roles: list<string>, permissions: list<string>}|null}> */
    private array $users = [];

    /** @var array<string, true> user tokens that were revoked or logged out upstream */
    private array $revoked = [];

    private ?string $serviceRejection = null;

    /** @var list<string> service tokens accepted besides {@see SERVICE_TOKEN} (a rotated or re-entered credential) */
    private array $extraServiceTokens = [];

    private ?string $outage = null;

    private int $sequence = 10;

    /** @var array<string, int> attempts per auth path, counted even when the "network" failed */
    private array $attempts = [];

    public function __construct(private readonly string $baseUrl = self::BASE_URL) {}

    public static function make(string $baseUrl = self::BASE_URL): self
    {
        return new self($baseUrl);
    }

    /**
     * The `response.body` of a captured sample.
     *
     * @return array<string, mixed>
     */
    public static function fixture(string $name): array
    {
        $decoded = json_decode((string) file_get_contents(base_path("tests/fixtures/pizzasys/{$name}.json")), true);

        return $decoded['response']['body'];
    }

    public static function fixtureStatus(string $name): int
    {
        $decoded = json_decode((string) file_get_contents(base_path("tests/fixtures/pizzasys/{$name}.json")), true);

        return (int) $decoded['response']['status'];
    }

    /**
     * @param  string  $profile  admin | chatadmin | agent | roleagent | norole | storeuser (sample the claims are taken from)
     */
    public function user(string $email, string $password, string $profile, ?string $name = null): self
    {
        $id = (string) ++$this->sequence;

        $this->users[$email] = [
            'password' => $password,
            'profile' => $profile,
            'tokens' => [$id.'|'.Str::random(48)],
            'id' => $id,
            'name' => $name ?? ucfirst($profile).' User',
            'claims' => null,
        ];

        return $this;
    }

    /**
     * Change what the portal reports for a user from now on.
     *
     * @param  list<string>  $roles
     * @param  list<string>  $permissions
     */
    public function claims(string $email, array $roles, array $permissions): self
    {
        $this->users[$email]['claims'] = ['roles' => $roles, 'permissions' => $permissions];

        return $this;
    }

    public function tokenFor(string $email): string
    {
        return $this->users[$email]['tokens'][array_key_last($this->users[$email]['tokens'])];
    }

    public function idFor(string $email): string
    {
        return $this->users[$email]['id'];
    }

    /** The portal forgets the user's token(s): `token-verify` answers HTTP 200 `active:false`. */
    public function revoke(string $email): self
    {
        foreach ($this->users[$email]['tokens'] as $token) {
            $this->revoked[$token] = true;
        }

        return $this;
    }

    /** The user logs in again: a fresh token, the old one stays valid (the real portal never revokes on login). */
    public function reissueToken(string $email): string
    {
        $token = $this->users[$email]['id'].'|'.Str::random(48);
        $this->users[$email]['tokens'][] = $token;

        return $token;
    }

    /** Our SERVICE credential is refused (`token-verify` answers HTTP 401 with this message). */
    public function rejectServiceCredential(string $message = 'Invalid service token.'): self
    {
        $this->serviceRejection = $message;

        return $this;
    }

    /** The portal also knows this service token (for example one an administrator just typed in Settings). */
    public function acceptServiceToken(string $token): self
    {
        $this->extraServiceTokens[] = $token;

        return $this;
    }

    public function acceptServiceCredential(): self
    {
        $this->serviceRejection = null;

        return $this;
    }

    /**
     * @param  'connection'|'timeout'|'server_error'|'html'|'tls'|null  $kind
     */
    public function outage(?string $kind): self
    {
        $this->outage = $kind;

        return $this;
    }

    public function recover(): self
    {
        return $this->outage(null);
    }

    public function fake(): self
    {
        Http::fake([
            rtrim($this->baseUrl, '/').'/*' => fn (Request $request) => $this->respond($request),
        ]);

        return $this;
    }

    /** How many calls to `/auth/<path>` were attempted against this portal (login, token-verify, me, logout), outages included. */
    public function calls(string $path): int
    {
        return $this->attempts[$path] ?? 0;
    }

    /**
     * @return Collection<int, Request>
     */
    public function recorded(string $path): Collection
    {
        return Http::recorded()
            ->map(fn (array $pair): Request => $pair[0])
            ->filter(fn (Request $request): bool => str_starts_with($request->url(), $this->baseUrl) && str_ends_with($request->url(), '/auth/'.$path))
            ->values();
    }

    public function assertNoCalls(): void
    {
        Assert::assertSame(0, Http::recorded()->filter(fn (array $pair): bool => str_starts_with($pair[0]->url(), $this->baseUrl))->count(), 'The portal was called.');
    }

    private function respond(Request $request): mixed
    {
        $attempted = Str::afterLast((string) parse_url($request->url(), PHP_URL_PATH), '/auth/');
        $this->attempts[$attempted] = ($this->attempts[$attempted] ?? 0) + 1;

        if ($this->outage !== null) {
            return match ($this->outage) {
                'connection' => throw new ConnectionException('cURL error 7: Failed to connect to auth.example.test port 443'),
                'timeout' => throw new ConnectionException('cURL error 28: Operation timed out after 3001 milliseconds'),
                'tls' => throw new ConnectionException('cURL error 60: SSL certificate problem: self-signed certificate'),
                'server_error' => Http::response('Server Error', 500),
                default => Http::response('<html>Maintenance</html>', 200, ['Content-Type' => 'text/html']),
            };
        }

        $path = (string) Str::after((string) parse_url($request->url(), PHP_URL_PATH), '/api/v1');
        $body = $request->data();

        return match (true) {
            $path === '/auth/login' => $this->login($body),
            $path === '/auth/token-verify' => $this->verify($request, $body),
            $path === '/auth/me' => $this->me($request),
            $path === '/auth/logout' => $this->logout($request),
            default => Http::response(['message' => 'Not found'], 404),
        };
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function login(array $body): mixed
    {
        $email = $body['email'] ?? null;
        $password = $body['password'] ?? null;

        if (! is_string($email) || ! filter_var($email, FILTER_VALIDATE_EMAIL) || ! is_string($password)) {
            return Http::response(self::fixture('login-malformed-bad-email'), 422);
        }

        $user = $this->users[$email] ?? null;

        if ($user === null || $user['password'] !== $password) {
            return Http::response(self::fixture('login-invalid'), 401);
        }

        $payload = self::fixture('login-ok');
        $payload['data']['token'] = $this->reissueToken($email);
        $payload['data']['user']['id'] = (int) $user['id'];
        $payload['data']['user']['name'] = $user['name'];
        $payload['data']['user']['email'] = $email;

        return Http::response($payload, 200);
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function verify(Request $request, array $body): mixed
    {
        $bearer = Str::after($request->header('Authorization')[0] ?? '', 'Bearer ');

        if (($request->header('Authorization')[0] ?? '') === '') {
            return Http::response(self::fixture('token-verify-bad-service-missing-bearer'), 401);
        }

        if ($this->serviceRejection !== null) {
            return Http::response(['message' => $this->serviceRejection], 401);
        }

        if ($bearer !== self::SERVICE_TOKEN && ! in_array($bearer, $this->extraServiceTokens, true)) {
            return Http::response(self::fixture('token-verify-bad-service-wrong-bearer'), 401);
        }

        if (($body['service'] ?? null) !== self::SERVICE_NAME) {
            return Http::response(self::fixture('token-verify-bad-service-unknown-service'), 401);
        }

        $user = $this->userByToken((string) ($body['token'] ?? ''));

        if ($user === null) {
            return Http::response(self::fixture('token-verify-inactive'), 200);
        }

        [$email, $account] = $user;

        $payload = self::fixture('token-verify-active-'.$account['profile']);
        $payload['sub'] = $account['id'];
        $payload['user'] = ['id' => (int) $account['id'], 'name' => $account['name'], 'email' => $email];

        if ($account['claims'] !== null) {
            $payload['roles'] = $account['claims']['roles'];
            $payload['permissions'] = $account['claims']['permissions'];
        }

        return Http::response($payload, 200);
    }

    private function me(Request $request): mixed
    {
        $token = Str::after($request->header('Authorization')[0] ?? '', 'Bearer ');
        $user = $this->userByToken($token);

        if ($user === null) {
            return Http::response(self::fixture('me-unauthenticated'), 401);
        }

        [$email, $account] = $user;

        $payload = self::fixture('me-'.$account['profile']);
        $payload['data']['user']['id'] = (int) $account['id'];
        $payload['data']['user']['name'] = $account['name'];
        $payload['data']['user']['email'] = $email;

        if ($account['claims'] !== null) {
            $payload['data']['user']['global_roles'] = array_map(fn (string $role): array => ['id' => 1, 'name' => $role, 'guard_name' => 'web', 'permissions' => []], $account['claims']['roles']);
            $payload['data']['user']['global_permissions'] = array_map(fn (string $permission): array => ['id' => 1, 'name' => $permission, 'guard_name' => 'web'], $account['claims']['permissions']);
        }

        return Http::response($payload, 200);
    }

    private function logout(Request $request): mixed
    {
        $token = Str::after($request->header('Authorization')[0] ?? '', 'Bearer ');

        if ($this->userByToken($token) === null) {
            return Http::response(self::fixture('me-unauthenticated'), 401);
        }

        $this->revoked[$token] = true;

        return Http::response(self::fixture('logout-ok'), 200);
    }

    /**
     * @return array{0: string, 1: array{password: string, profile: string, tokens: list<string>, id: string, name: string, claims: array{roles: list<string>, permissions: list<string>}|null}}|null
     */
    private function userByToken(string $token): ?array
    {
        if ($token === '' || isset($this->revoked[$token])) {
            return null;
        }

        foreach ($this->users as $email => $account) {
            foreach ($account['tokens'] as $known) {
                if (hash_equals($known, $token)) {
                    return [$email, $account];
                }
            }
        }

        return null;
    }
}
