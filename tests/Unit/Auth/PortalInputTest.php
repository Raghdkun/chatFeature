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
            'https private address' => ['https://10.0.0.5', false],
            'https loopback' => ['https://127.0.0.1', false],
            'http localhost' => ['http://localhost:8200', false],
            'http loopback' => ['http://127.0.0.1:8200', false],
            'http ipv6 loopback' => ['http://[::1]:8200', false],
            'http .test host' => ['http://portal.test', true],
            'decimal ip' => ['https://2852039166', false],
            'hex ip' => ['https://0xA9FEA9FE', false],
            'mapped metadata' => ['https://[::ffff:169.254.169.254]', false],
            'metadata name with root dot' => ['https://metadata.google.internal.', false],
            'aws ipv6 metadata' => ['https://[fd00:ec2::254]', false],
            'unspecified' => ['https://0.0.0.0', false],
            'x.localhost with a port' => ['http://x.localhost:6379', false],
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

    public function test_private_and_loopback_portals_are_accepted_on_a_private_network_deployment(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        foreach (['https://10.0.0.5', 'http://localhost:8200', 'http://127.0.0.1:8200', 'http://[::1]:8200', 'http://x.localhost:6379'] as $url) {
            $this->assertTrue(Validator::make(['url' => $url], ['url' => [new PortalUrl]])->passes(), $url);
        }

        foreach (['https://169.254.169.254', 'https://2852039166', 'https://[::ffff:169.254.169.254]', 'https://metadata.google.internal.', 'http://10.0.0.5'] as $url) {
            $this->assertFalse(Validator::make(['url' => $url], ['url' => [new PortalUrl]])->passes(), $url);
        }
    }

    public function test_a_refused_address_gets_one_message_whatever_the_reason(): void
    {
        $messages = [];

        foreach (['https://10.0.0.5', 'https://127.0.0.1', 'https://169.254.169.254', 'https://2852039166', 'https://metadata.google.internal', 'https://[fd00:ec2::254]', 'https://pizzasys', 'https://printer.local'] as $url) {
            $messages[$url] = Validator::make(['url' => $url], ['url' => [new PortalUrl]])->errors()->first('url');
        }

        $this->assertCount(1, array_unique($messages), json_encode($messages));
        $this->assertStringNotContainsString('private', (string) reset($messages));
        $this->assertStringNotContainsString('resolve', (string) reset($messages));
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
            'public ip' => ['nats://8.8.8.8:4222', true],
            'private ip' => ['nats://10.0.0.7:4222', false],
            'loopback' => ['nats://127.0.0.1:4222', false],
            'metadata' => ['nats://169.254.169.254:4222', false],
            'decimal ip' => ['nats://2130706433:4222', false],
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

    public function test_claims_accept_numeric_ids_and_fall_back_to_the_readable_part_of_the_email_for_the_name(): void
    {
        $claims = PortalClaims::fromVerifyPayload([
            'active' => true,
            'sub' => 12,
            'user' => ['id' => 12, 'name' => '', 'email' => 'ann.smith@b.test'],
            'roles' => ['x', ['name' => 'y'], 5, ''],
            'permissions' => ['p', 'p'],
            'exp' => 1790000000,
        ]);

        $this->assertSame('12', $claims->sub);
        $this->assertSame('Ann Smith', $claims->name, 'never the address itself: visitors see this name');
        $this->assertSame('ann.smith@b.test', $claims->email);
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
