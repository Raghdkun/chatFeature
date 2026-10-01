<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Identity\IdentityFailure;
use App\Domain\Widgets\Identity\IdentityTokenVerifier;
use Carbon\Carbon;
use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\Repository;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Tests\Support\WidgetFixtures;

class IdentityTokenVerifierTest extends TestCase
{
    use WidgetFixtures;

    private const KEY = 'wk_testkey0123456789ab';

    private const SECRET = 'a-very-long-random-widget-secret-0123456789';

    private const NOW = 1_800_000_000;

    private IdentityTokenVerifier $verifier;

    protected function setUp(): void
    {
        parent::setUp();

        $this->verifier = new IdentityTokenVerifier;
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function claims(array $overrides = []): array
    {
        return array_merge(['iss' => self::KEY, 'exp' => self::NOW + 120], $overrides);
    }

    private function assertFails(IdentityFailure $expected, string $token, string $secret = self::SECRET): void
    {
        $result = $this->verifier->verify($token, self::KEY, $secret, self::NOW);

        $this->assertFalse($result->isValid());
        $this->assertSame($expected, $result->failure);
        $this->assertNull($result->identity);
    }

    public function test_a_valid_token_yields_the_identity(): void
    {
        $token = $this->mintIdentityToken($this->claims([
            'iat' => self::NOW - 5,
            'sub' => 'user-42',
            'name' => 'Ada Lovelace',
            'email' => 'ada@example.com',
            'phone' => '+44 20 7946 0958',
            'meta' => ['plan' => 'pro', 'seats' => 5, 'beta' => true],
        ]), self::SECRET);

        $result = $this->verifier->verify($token, self::KEY, self::SECRET, self::NOW);

        $this->assertTrue($result->isValid());
        $this->assertNull($result->failure);
        $this->assertSame([
            'sub' => 'user-42',
            'name' => 'Ada Lovelace',
            'email' => 'ada@example.com',
            'phone' => '+44 20 7946 0958',
            'meta' => ['plan' => 'pro', 'seats' => 5, 'beta' => true],
        ], $result->identity?->toArray());
    }

    public function test_only_iss_and_exp_are_required(): void
    {
        $result = $this->verifier->verify($this->mintIdentityToken($this->claims(), self::SECRET), self::KEY, self::SECRET, self::NOW);

        $this->assertTrue($result->isValid());
        $this->assertSame(['sub' => null, 'name' => null, 'email' => null, 'phone' => null, 'meta' => []], $result->identity?->toArray());
    }

    public function test_a_numeric_subject_is_kept_as_text(): void
    {
        $result = $this->verifier->verify($this->mintIdentityToken($this->claims(['sub' => 12345]), self::SECRET), self::KEY, self::SECRET, self::NOW);

        $this->assertSame('12345', $result->identity?->subject);
    }

    public function test_expired_tokens_are_rejected(): void
    {
        $this->assertFails(IdentityFailure::Expired, $this->mintIdentityToken($this->claims(['exp' => self::NOW - 1]), self::SECRET));
        $this->assertFails(IdentityFailure::Expired, $this->mintIdentityToken($this->claims(['exp' => self::NOW]), self::SECRET));
    }

    public function test_expiry_must_be_within_five_minutes(): void
    {
        $this->assertTrue($this->verifier->verify($this->mintIdentityToken($this->claims(['exp' => self::NOW + 300]), self::SECRET), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertFails(IdentityFailure::ExpiryTooFar, $this->mintIdentityToken($this->claims(['exp' => self::NOW + 301]), self::SECRET));
        $this->assertFails(IdentityFailure::ExpiryTooFar, $this->mintIdentityToken($this->claims(['exp' => self::NOW + 86_400 * 365]), self::SECRET));
    }

    public function test_a_missing_or_non_numeric_expiry_is_rejected(): void
    {
        $this->assertFails(IdentityFailure::MissingExpiry, $this->mintIdentityToken(['iss' => self::KEY], self::SECRET));
        $this->assertFails(IdentityFailure::MissingExpiry, $this->mintIdentityToken($this->claims(['exp' => (string) (self::NOW + 60)]), self::SECRET));
        $this->assertFails(IdentityFailure::MissingExpiry, $this->mintIdentityToken($this->claims(['exp' => null]), self::SECRET));
    }

    public function test_issued_at_and_not_before_may_not_be_in_the_future(): void
    {
        $this->assertTrue($this->verifier->verify($this->mintIdentityToken($this->claims(['iat' => self::NOW + 60]), self::SECRET), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertFails(IdentityFailure::NotYetValid, $this->mintIdentityToken($this->claims(['iat' => self::NOW + 61]), self::SECRET));
        $this->assertFails(IdentityFailure::NotYetValid, $this->mintIdentityToken($this->claims(['iat' => self::NOW + 600]), self::SECRET));
        $this->assertFails(IdentityFailure::NotYetValid, $this->mintIdentityToken($this->claims(['nbf' => self::NOW + 600]), self::SECRET));
        $this->assertFails(IdentityFailure::InvalidClaims, $this->mintIdentityToken($this->claims(['iat' => 'yesterday']), self::SECRET));
    }

    public function test_the_wrong_secret_is_rejected(): void
    {
        $this->assertFails(IdentityFailure::BadSignature, $this->mintIdentityToken($this->claims(), 'another-secret'));
        $this->assertFails(IdentityFailure::BadSignature, $this->mintIdentityToken($this->claims(), self::SECRET), 'rotated-secret');
    }

    public function test_a_tampered_payload_is_rejected(): void
    {
        $token = $this->mintIdentityToken($this->claims(['sub' => 'user-1']), self::SECRET);
        [$header, , $signature] = explode('.', $token);
        $forgedPayload = rtrim(strtr(base64_encode((string) json_encode($this->claims(['sub' => 'admin-1']))), '+/', '-_'), '=');

        $this->assertFails(IdentityFailure::BadSignature, $header.'.'.$forgedPayload.'.'.$signature);
    }

    public function test_a_tampered_header_is_rejected(): void
    {
        $token = $this->mintIdentityToken($this->claims(), self::SECRET);
        [, $payload, $signature] = explode('.', $token);
        $forgedHeader = rtrim(strtr(base64_encode((string) json_encode(['alg' => 'HS256', 'typ' => 'JWT', 'kid' => 'x'])), '+/', '-_'), '=');

        $this->assertFails(IdentityFailure::BadSignature, $forgedHeader.'.'.$payload.'.'.$signature);
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string|null}>
     */
    public static function unsupportedAlgorithms(): array
    {
        return [
            'none without signature' => [['alg' => 'none', 'typ' => 'JWT'], null],
            'NONE' => [['alg' => 'NONE', 'typ' => 'JWT'], null],
            'HS512 correctly signed' => [['alg' => 'HS512', 'typ' => 'JWT'], 'sha512'],
            'HS384 correctly signed' => [['alg' => 'HS384', 'typ' => 'JWT'], 'sha384'],
            'RS256 header with an hmac signature' => [['alg' => 'RS256', 'typ' => 'JWT'], 'sha256'],
            'lower-case hs256' => [['alg' => 'hs256', 'typ' => 'JWT'], 'sha256'],
            'missing alg' => [['typ' => 'JWT'], 'sha256'],
            'alg as list' => [['alg' => ['HS256']], 'sha256'],
        ];
    }

    /**
     * @param  array<string, mixed>  $header
     */
    #[DataProvider('unsupportedAlgorithms')]
    public function test_only_hs256_is_accepted(array $header, ?string $algorithm): void
    {
        $this->assertFails(IdentityFailure::UnsupportedAlgorithm, $this->mintIdentityToken($this->claims(), self::SECRET, $header, $algorithm));
    }

    public function test_an_alg_none_token_with_a_forged_signature_is_still_rejected(): void
    {
        $token = $this->mintIdentityToken($this->claims(), self::SECRET, ['alg' => 'none'], null);

        $this->assertFails(IdentityFailure::UnsupportedAlgorithm, $token);
        $this->assertFails(IdentityFailure::UnsupportedAlgorithm, $token.'AAAA');
    }

    public function test_the_issuer_must_be_the_widget_key(): void
    {
        $this->assertFails(IdentityFailure::WrongIssuer, $this->mintIdentityToken($this->claims(['iss' => 'wk_someotherwidget0000']), self::SECRET));
        $this->assertFails(IdentityFailure::WrongIssuer, $this->mintIdentityToken(['exp' => self::NOW + 60], self::SECRET));
        $this->assertFails(IdentityFailure::WrongIssuer, $this->mintIdentityToken($this->claims(['iss' => [self::KEY]]), self::SECRET));
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function malformedTokens(): array
    {
        return [
            'empty' => [''],
            'one segment' => ['abc'],
            'two segments' => ['a.b'],
            'four segments' => ['a.b.c.d'],
            'not base64url' => ['!!!.@@@.###'],
            'padding characters' => ['eyJhbGciOiJIUzI1NiJ9=.e30=.AAAA'],
            'header is not json' => [rtrim(strtr(base64_encode('not json'), '+/', '-_'), '=').'.e30.AAAA'],
            'header is a list' => [rtrim(strtr(base64_encode('["HS256"]'), '+/', '-_'), '=').'.e30.AAAA'],
            'empty segments' => ['..'],
            'too long' => [str_repeat('a', 9000)],
        ];
    }

    #[DataProvider('malformedTokens')]
    public function test_malformed_tokens_are_rejected(string $token): void
    {
        $result = $this->verifier->verify($token, self::KEY, self::SECRET, self::NOW);

        $this->assertFalse($result->isValid());
        $this->assertSame(IdentityFailure::Malformed, $result->failure);
    }

    public function test_a_signed_payload_that_is_not_an_object_is_malformed(): void
    {
        $header = rtrim(strtr(base64_encode((string) json_encode(['alg' => 'HS256'])), '+/', '-_'), '=');
        $payload = rtrim(strtr(base64_encode('[1,2,3]'), '+/', '-_'), '=');
        $signature = rtrim(strtr(base64_encode(hash_hmac('sha256', $header.'.'.$payload, self::SECRET, true)), '+/', '-_'), '=');

        $this->assertFails(IdentityFailure::Malformed, $header.'.'.$payload.'.'.$signature);
    }

    /**
     * @return array<string, array{0: array<string, mixed>}>
     */
    public static function invalidClaims(): array
    {
        return [
            'invalid email' => [['email' => 'not-an-email']],
            'email not a string' => [['email' => ['a@b.example']]],
            'name not a string' => [['name' => 12]],
            'name too long' => [['name' => str_repeat('x', 121)]],
            'phone with letters' => [['phone' => 'call me']],
            'sub too long' => [['sub' => str_repeat('x', 256)]],
            'sub empty' => [['sub' => '']],
            'sub an array' => [['sub' => ['a']]],
            'meta is a list' => [['meta' => ['a', 'b']]],
            'meta nested' => [['meta' => ['profile' => ['a' => 1]]]],
            'meta key with spaces' => [['meta' => ['bad key' => 'x']]],
            'meta value too long' => [['meta' => ['note' => str_repeat('x', 501)]]],
            'meta too many entries' => [['meta' => array_combine(array_map(fn (int $i): string => 'k'.$i, range(1, 21)), range(1, 21))]],
        ];
    }

    /**
     * @param  array<string, mixed>  $claims
     */
    #[DataProvider('invalidClaims')]
    public function test_wrongly_typed_claims_are_rejected_not_coerced(array $claims): void
    {
        $this->assertFails(IdentityFailure::InvalidClaims, $this->mintIdentityToken($this->claims($claims), self::SECRET));
    }

    public function test_an_empty_secret_never_verifies(): void
    {
        $token = $this->mintIdentityToken($this->claims(), '');

        $result = $this->verifier->verify($token, self::KEY, '', self::NOW);

        $this->assertSame(IdentityFailure::NoSecret, $result->failure);
    }

    public function test_the_documented_php_snippet_produces_verifiable_tokens(): void
    {
        // Same algorithm as the PHP example of EmbedSnippetBuilder.
        $secret = self::SECRET;
        $base64Url = static fn (string $data): string => rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
        $header = $base64Url((string) json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $payload = $base64Url((string) json_encode(['iss' => self::KEY, 'sub' => '7', 'name' => 'Ada', 'email' => 'ada@example.com', 'exp' => self::NOW + 300]));
        $signature = $base64Url(hash_hmac('sha256', "$header.$payload", $secret, true));

        $result = $this->verifier->verify("$header.$payload.$signature", self::KEY, $secret, self::NOW);

        $this->assertTrue($result->isValid());
        $this->assertSame('ada@example.com', $result->identity?->email);
    }

    // ---- single use (opt-in through `jti`) ---------------------------------------------------------------------------

    private function cache(): Repository
    {
        return new Repository(new ArrayStore);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();

        parent::tearDown();
    }

    public function test_a_token_with_a_jti_can_only_be_used_once(): void
    {
        $verifier = new IdentityTokenVerifier($this->cache());
        $token = $this->mintIdentityToken($this->claims(['jti' => 'login-7f3a', 'sub' => 'user-1']), self::SECRET);

        $first = $verifier->verify($token, self::KEY, self::SECRET, self::NOW);
        $replay = $verifier->verify($token, self::KEY, self::SECRET, self::NOW + 1);

        $this->assertTrue($first->isValid());
        $this->assertFalse($replay->isValid());
        $this->assertSame(IdentityFailure::Replayed, $replay->failure);
        $this->assertNull($replay->identity);
    }

    public function test_another_jti_or_another_widget_is_not_affected(): void
    {
        $verifier = new IdentityTokenVerifier($this->cache());
        $mint = fn (string $jti, string $key) => $this->mintIdentityToken(['iss' => $key, 'exp' => self::NOW + 120, 'jti' => $jti], self::SECRET);

        $this->assertTrue($verifier->verify($mint('a', self::KEY), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertTrue($verifier->verify($mint('b', self::KEY), self::KEY, self::SECRET, self::NOW)->isValid(), 'a different jti');
        $this->assertTrue($verifier->verify($mint('a', 'wk_otherwidget000000000'), 'wk_otherwidget000000000', self::SECRET, self::NOW)->isValid(), 'the same jti on another widget');
        $this->assertSame(IdentityFailure::Replayed, $verifier->verify($mint('a', self::KEY), self::KEY, self::SECRET, self::NOW)->failure);
    }

    public function test_tokens_without_a_jti_stay_reusable_until_they_expire(): void
    {
        $verifier = new IdentityTokenVerifier($this->cache());
        $token = $this->mintIdentityToken($this->claims(['sub' => 'user-1']), self::SECRET);

        foreach ([0, 10, 60, 119] as $offset) {
            $this->assertTrue($verifier->verify($token, self::KEY, self::SECRET, self::NOW + $offset)->isValid(), "at +{$offset}s");
        }
        $this->assertFalse($verifier->verify($token, self::KEY, self::SECRET, self::NOW + 120)->isValid());
    }

    public function test_the_jti_is_remembered_until_the_token_expires_and_no_longer(): void
    {
        $cache = $this->cache();
        $verifier = new IdentityTokenVerifier($cache);
        $key = 'widgets:identity-jti:'.sha1(self::KEY.'|login-1');

        Carbon::setTestNow(Carbon::createFromTimestamp(self::NOW));
        $this->assertTrue($verifier->verify($this->mintIdentityToken($this->claims(['jti' => 'login-1']), self::SECRET), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertTrue($cache->has($key));

        Carbon::setTestNow(Carbon::createFromTimestamp(self::NOW + 60));
        $this->assertTrue($cache->has($key), 'still remembered while the token is valid');

        Carbon::setTestNow(Carbon::createFromTimestamp(self::NOW + 130));
        $this->assertFalse($cache->has($key), 'forgotten once the token has expired (it is refused as expired by then)');
    }

    public function test_only_a_fully_valid_token_uses_up_its_jti(): void
    {
        $verifier = new IdentityTokenVerifier($this->cache());
        $valid = $this->mintIdentityToken($this->claims(['jti' => 'shared-jti', 'email' => 'ada@example.com']), self::SECRET);

        // Somebody who does not know the secret, a stale token and a token with a bad claim cannot burn the jti ...
        $this->assertSame(IdentityFailure::BadSignature, $verifier->verify($this->mintIdentityToken($this->claims(['jti' => 'shared-jti']), 'not-the-secret'), self::KEY, self::SECRET, self::NOW)->failure);
        $this->assertSame(IdentityFailure::Expired, $verifier->verify($this->mintIdentityToken($this->claims(['jti' => 'shared-jti', 'exp' => self::NOW - 5]), self::SECRET), self::KEY, self::SECRET, self::NOW)->failure);
        $this->assertSame(IdentityFailure::InvalidClaims, $verifier->verify($this->mintIdentityToken($this->claims(['jti' => 'shared-jti', 'email' => 'not-an-email']), self::SECRET), self::KEY, self::SECRET, self::NOW)->failure);

        // ... so the genuine token still works once, and only once.
        $this->assertTrue($verifier->verify($valid, self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertSame(IdentityFailure::Replayed, $verifier->verify($valid, self::KEY, self::SECRET, self::NOW)->failure);
    }

    /**
     * @return array<string, array{0: mixed}>
     */
    public static function invalidJtis(): array
    {
        return [
            'empty' => [''],
            'integer' => [12345],
            'array' => [['a']],
            'null' => [null],
            'too long' => [str_repeat('x', 129)],
        ];
    }

    #[DataProvider('invalidJtis')]
    public function test_a_malformed_jti_is_rejected(mixed $jti): void
    {
        $this->assertFails(IdentityFailure::InvalidClaims, $this->mintIdentityToken($this->claims(['jti' => $jti]), self::SECRET));
    }

    public function test_the_longest_jti_is_accepted(): void
    {
        $result = (new IdentityTokenVerifier($this->cache()))->verify($this->mintIdentityToken($this->claims(['jti' => str_repeat('x', 128)]), self::SECRET), self::KEY, self::SECRET, self::NOW);

        $this->assertTrue($result->isValid());
    }

    public function test_without_a_cache_the_jti_is_validated_but_not_tracked(): void
    {
        $token = $this->mintIdentityToken($this->claims(['jti' => 'login-9']), self::SECRET);

        $this->assertTrue($this->verifier->verify($token, self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertTrue($this->verifier->verify($token, self::KEY, self::SECRET, self::NOW)->isValid());
    }

    // ---- the lifetime knob -------------------------------------------------------------------------------------------

    public function test_the_maximum_lifetime_is_configurable(): void
    {
        $short = new IdentityTokenVerifier(null, 60);
        $long = new IdentityTokenVerifier(null, 900);
        $at = fn (int $seconds): string => $this->mintIdentityToken($this->claims(['exp' => self::NOW + $seconds]), self::SECRET);

        $this->assertTrue($short->verify($at(60), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertSame(IdentityFailure::ExpiryTooFar, $short->verify($at(61), self::KEY, self::SECRET, self::NOW)->failure);
        $this->assertTrue($long->verify($at(900), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertSame(IdentityFailure::ExpiryTooFar, $long->verify($at(901), self::KEY, self::SECRET, self::NOW)->failure);
        $this->assertSame(300, IdentityTokenVerifier::MAX_LIFETIME_SECONDS, 'the default is five minutes');
    }

    public function test_a_nonsensical_lifetime_setting_cannot_disable_the_check(): void
    {
        $verifier = new IdentityTokenVerifier(null, 0);

        $this->assertTrue($verifier->verify($this->mintIdentityToken($this->claims(['exp' => self::NOW + 1]), self::SECRET), self::KEY, self::SECRET, self::NOW)->isValid());
        $this->assertSame(IdentityFailure::ExpiryTooFar, $verifier->verify($this->mintIdentityToken($this->claims(['exp' => self::NOW + 2]), self::SECRET), self::KEY, self::SECRET, self::NOW)->failure);
    }
}
