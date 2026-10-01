<?php

namespace App\Domain\Widgets\Identity;

use App\Models\Widget;

/**
 * Verifies the HS256 JWT a host site mints with a widget's identity secret (docs/widget-embed-api.md).
 *
 * Deliberately tiny and dependency-free: only `alg: HS256` is accepted (`none`, `HS512`, `RS256`, ... are
 * refused before any signature work), the signature is compared with `hash_equals`, `iss` must be the widget's
 * public key and `exp` must lie in the next 5 minutes (short-lived tokens only). `iat`/`nbf` may not be in
 * the future. The claims `sub`, `name`, `email`, `phone`, `meta` are optional and type-checked, never coerced.
 */
final class IdentityTokenVerifier
{
    /** `exp` may be at most this many seconds ahead of the verifier's clock. */
    public const MAX_LIFETIME_SECONDS = 300;

    /** `iat` / `nbf` may be at most this far ahead (clock skew between the host's server and ours). */
    public const MAX_FUTURE_SKEW_SECONDS = 60;

    private const MAX_TOKEN_BYTES = 8192;

    private const MAX_META_ENTRIES = 20;

    private const MAX_META_BYTES = 4096;

    public function verifyForWidget(string $token, Widget $widget, ?int $now = null): IdentityVerification
    {
        $secret = $widget->identitySecret();

        if ($secret === null || $secret === '') {
            return IdentityVerification::failed(IdentityFailure::NoSecret);
        }

        return $this->verify($token, $widget->public_key, $secret, $now);
    }

    public function verify(string $token, string $publicKey, string $secret, ?int $now = null): IdentityVerification
    {
        $now ??= now()->getTimestamp();

        if ($secret === '') {
            return IdentityVerification::failed(IdentityFailure::NoSecret);
        }

        if ($token === '' || strlen($token) > self::MAX_TOKEN_BYTES) {
            return IdentityVerification::failed(IdentityFailure::Malformed);
        }

        $segments = explode('.', $token);

        if (count($segments) !== 3) {
            return IdentityVerification::failed(IdentityFailure::Malformed);
        }

        [$encodedHeader, $encodedPayload, $encodedSignature] = $segments;

        $header = $this->decodeJson($encodedHeader);

        if ($header === null) {
            return IdentityVerification::failed(IdentityFailure::Malformed);
        }

        if (($header['alg'] ?? null) !== 'HS256') {
            return IdentityVerification::failed(IdentityFailure::UnsupportedAlgorithm);
        }

        $signature = $this->base64UrlDecode($encodedSignature);

        if ($signature === null) {
            return IdentityVerification::failed(IdentityFailure::Malformed);
        }

        $expected = hash_hmac('sha256', $encodedHeader.'.'.$encodedPayload, $secret, true);

        if (! hash_equals($expected, $signature)) {
            return IdentityVerification::failed(IdentityFailure::BadSignature);
        }

        $claims = $this->decodeJson($encodedPayload);

        if ($claims === null) {
            return IdentityVerification::failed(IdentityFailure::Malformed);
        }

        return $this->checkClaims($claims, $publicKey, $now);
    }

    /**
     * @param  array<string, mixed>  $claims
     */
    private function checkClaims(array $claims, string $publicKey, int $now): IdentityVerification
    {
        $issuer = $claims['iss'] ?? null;

        if (! is_string($issuer) || ! hash_equals($publicKey, $issuer)) {
            return IdentityVerification::failed(IdentityFailure::WrongIssuer);
        }

        $expiry = $claims['exp'] ?? null;

        if (! is_int($expiry) && ! is_float($expiry)) {
            return IdentityVerification::failed(IdentityFailure::MissingExpiry);
        }

        if ($expiry <= $now) {
            return IdentityVerification::failed(IdentityFailure::Expired);
        }

        if ($expiry > $now + self::MAX_LIFETIME_SECONDS) {
            return IdentityVerification::failed(IdentityFailure::ExpiryTooFar);
        }

        foreach (['iat', 'nbf'] as $claim) {
            if (! array_key_exists($claim, $claims)) {
                continue;
            }

            if (! is_int($claims[$claim]) && ! is_float($claims[$claim])) {
                return IdentityVerification::failed(IdentityFailure::InvalidClaims);
            }

            if ($claims[$claim] > $now + self::MAX_FUTURE_SKEW_SECONDS) {
                return IdentityVerification::failed(IdentityFailure::NotYetValid);
            }
        }

        $identity = $this->identityFrom($claims);

        return $identity === null
            ? IdentityVerification::failed(IdentityFailure::InvalidClaims)
            : IdentityVerification::verified($identity);
    }

    /**
     * @param  array<string, mixed>  $claims
     */
    private function identityFrom(array $claims): ?VerifiedIdentity
    {
        $subject = $claims['sub'] ?? null;

        if (is_int($subject)) {
            $subject = (string) $subject;
        }

        $name = $claims['name'] ?? null;
        $email = $claims['email'] ?? null;
        $phone = $claims['phone'] ?? null;
        $meta = $claims['meta'] ?? [];

        if (($subject !== null && (! is_string($subject) || $subject === '' || strlen($subject) > 255))
            || ($name !== null && (! is_string($name) || mb_strlen($name) > 120))
            || ($email !== null && (! is_string($email) || strlen($email) > 190 || filter_var($email, FILTER_VALIDATE_EMAIL) === false))
            || ($phone !== null && (! is_string($phone) || preg_match('/^[0-9+().\- ]{3,40}$/D', $phone) !== 1))
        ) {
            return null;
        }

        $meta = $this->cleanMeta($meta);

        if ($meta === null) {
            return null;
        }

        return new VerifiedIdentity(
            subject: $subject,
            name: $name === null ? null : trim($name),
            email: $email,
            phone: $phone,
            meta: $meta,
        );
    }

    /**
     * @return array<string, scalar|null>|null
     */
    private function cleanMeta(mixed $meta): ?array
    {
        if (! is_array($meta) || ($meta !== [] && array_is_list($meta)) || count($meta) > self::MAX_META_ENTRIES) {
            return null;
        }

        foreach ($meta as $key => $value) {
            if (! is_string($key) || preg_match('/^[A-Za-z0-9_.\-]{1,64}$/D', $key) !== 1) {
                return null;
            }

            if (! is_null($value) && ! is_scalar($value)) {
                return null;
            }

            if (is_string($value) && mb_strlen($value) > 500) {
                return null;
            }
        }

        if (strlen((string) json_encode($meta)) > self::MAX_META_BYTES) {
            return null;
        }

        return $meta;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function decodeJson(string $segment): ?array
    {
        $raw = $this->base64UrlDecode($segment);

        if ($raw === null) {
            return null;
        }

        $decoded = json_decode($raw, true, 8);

        return is_array($decoded) && ! array_is_list($decoded) ? $decoded : null;
    }

    private function base64UrlDecode(string $segment): ?string
    {
        if ($segment === '' || preg_match('/^[A-Za-z0-9_-]+$/D', $segment) !== 1) {
            return null;
        }

        $padded = strtr($segment, '-_', '+/');
        $padded .= str_repeat('=', (4 - strlen($padded) % 4) % 4);

        $decoded = base64_decode($padded, true);

        return $decoded === false ? null : $decoded;
    }
}
