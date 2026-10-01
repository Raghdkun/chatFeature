<?php

namespace Tests\Unit\Auth;

use App\Auth\Pizzasys\Results\PortalClaims;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
use Illuminate\Support\Facades\Validator;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class PortalInputTest extends TestCase
{
    /**
     * @return array<string, array{0: string, 1: bool}>
     */
    public static function portalUrls(): array
    {
        return [
            'https host' => ['https://auth.example.com', true],
            'https with port and path' => ['https://auth.example.com:8443/portal', true],
            'https private address' => ['https://10.0.0.5', true],
            'http localhost' => ['http://localhost:8200', true],
            'http loopback' => ['http://127.0.0.1:8200', true],
            'http ipv6 loopback' => ['http://[::1]:8200', true],
            'http .test host' => ['http://portal.test', true],
            'http real host' => ['http://auth.example.com', false],
            'http private address' => ['http://10.0.0.5', false],
            'ftp' => ['ftp://auth.example.com', false],
            'javascript' => ['javascript:alert(1)', false],
            'credentials' => ['https://user:secret@auth.example.com', false],
            'query' => ['https://auth.example.com?x=1', false],
            'fragment' => ['https://auth.example.com#x', false],
            'no scheme' => ['auth.example.com', false],
            'cloud metadata' => ['https://169.254.169.254', false],
            'cloud metadata name' => ['https://metadata.google.internal', false],
            'link-local ipv6' => ['https://[fe80::1]', false],
            'empty' => ['', false],
            'too long' => ['https://'.str_repeat('a', 260).'.example.com', false],
        ];
    }

    #[DataProvider('portalUrls')]
    public function test_the_portal_url_rule(string $url, bool $valid): void
    {
        $passes = Validator::make(['url' => $url], ['url' => ['required', new PortalUrl]])->passes();

        $this->assertSame($valid, $passes, $url);
    }

    /**
     * @return array<string, array{0: string, 1: bool}>
     */
    public static function natsUrls(): array
    {
        return [
            'nats' => ['nats://nats.example.com:4222', true],
            'nats without port' => ['nats://nats.example.com', true],
            'tls' => ['tls://nats.example.com:4222', true],
            'ip' => ['nats://10.0.0.7:4222', true],
            'http' => ['http://nats.example.com', false],
            'credentials in the url' => ['nats://user:pass@nats.example.com:4222', false],
            'path' => ['nats://nats.example.com:4222/x', false],
            'no host' => ['nats://', false],
        ];
    }

    #[DataProvider('natsUrls')]
    public function test_the_nats_url_rule(string $url, bool $valid): void
    {
        $this->assertSame($valid, Validator::make(['url' => $url], ['url' => ['required', new NatsUrl]])->passes(), $url);
    }

    public function test_claims_accept_numeric_ids_and_fall_back_to_the_email_for_the_name(): void
    {
        $claims = PortalClaims::fromVerifyPayload([
            'active' => true,
            'sub' => 12,
            'user' => ['id' => 12, 'name' => '', 'email' => 'a@b.test'],
            'roles' => ['x', ['name' => 'y'], 5, ''],
            'permissions' => ['p', 'p'],
            'exp' => 1790000000,
        ]);

        $this->assertSame('12', $claims->sub);
        $this->assertSame('a@b.test', $claims->name);
        $this->assertSame(['x', 'y'], $claims->roles);
        $this->assertSame(['p'], $claims->permissions);
        $this->assertSame(1790000000, $claims->exp);
    }

    public function test_claims_without_an_identity_are_rejected(): void
    {
        $this->assertNull(PortalClaims::fromVerifyPayload(['active' => true, 'user' => ['email' => 'a@b.test']]));
        $this->assertNull(PortalClaims::fromVerifyPayload(['active' => true, 'sub' => '1', 'user' => []]));
        $this->assertNull(PortalClaims::fromMePayload(['data' => ['user' => ['id' => 1]]]));
        $this->assertNull(PortalClaims::fromArray(['sub' => '1']));
    }

    public function test_claims_survive_a_cache_round_trip(): void
    {
        $claims = new PortalClaims('7', 'Ada', 'ada@example.test', ['r'], ['p'], null);

        $this->assertEquals($claims, PortalClaims::fromArray($claims->toArray()));
    }
}
