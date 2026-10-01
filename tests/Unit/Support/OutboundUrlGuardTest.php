<?php

namespace Tests\Unit\Support;

use App\Support\Network\HostResolver;
use App\Support\Network\OutboundTarget;
use App\Support\Network\OutboundUrlGuard;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeHostResolver;
use Tests\TestCase;

/**
 * The SSRF guard for the addresses an administrator types in (auth portal base URL, NATS address). A fake resolver
 * stands in for DNS, so nothing here touches a network.
 */
class OutboundUrlGuardTest extends TestCase
{
    private FakeHostResolver $resolver;

    protected function setUp(): void
    {
        parent::setUp();

        $this->resolver = new FakeHostResolver([
            'rebind.example.test' => [FakeHostResolver::PUBLIC_ADDRESS, '10.0.0.5'],
            'internal-only.example.test' => ['10.1.2.3'],
            'loopback.example.test' => ['127.0.0.1'],
            'metadata.example.test' => ['169.254.169.254'],
            'mapped.example.test' => ['::ffff:10.0.0.1'],
            'v6.example.test' => ['2606:4700:4700::1111'],
            'nothing.example.test' => [],
        ]);
        $this->app->instance(HostResolver::class, $this->resolver);
    }

    private function guard(): OutboundUrlGuard
    {
        return $this->app->make(OutboundUrlGuard::class);
    }

    private function http(string $url): OutboundTarget
    {
        return $this->guard()->checkHttpUrl($url);
    }

    // ---- the default policy: public hosts only --------------------------------------------------------------------

    /**
     * @return array<string, array{0: string}>
     */
    public static function publicHttpUrls(): array
    {
        return [
            'plain host' => ['https://auth.example.com'],
            'port and path' => ['https://auth.example.com:8443/portal'],
            'upper case' => ['https://AUTH.Example.COM'],
            'trailing root dot' => ['https://auth.example.com.'],
            'public ipv4' => ['https://8.8.8.8'],
            'public ipv6' => ['https://[2606:4700:4700::1111]:8443'],
            'a name with a public ipv6 answer' => ['https://v6.example.test'],
            'http to a .test name' => ['http://portal.test'],
            'hyphens and digits' => ['https://auth-2.eu-west1.example.co.uk'],
        ];
    }

    #[DataProvider('publicHttpUrls')]
    public function test_public_addresses_are_accepted(string $url): void
    {
        $this->assertTrue($this->http($url)->ok, $url);
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function refusedHttpUrls(): array
    {
        return [
            // the probes of the security review
            'mapped metadata' => ['https://[::ffff:169.254.169.254]'],
            'decimal ip' => ['https://2852039166'],
            'hex ip' => ['https://0xA9FEA9FE'],
            'metadata name with root dot' => ['https://metadata.google.internal.'],
            'aws ipv6 metadata' => ['https://[fd00:ec2::254]'],
            'rfc1918' => ['https://10.0.0.5'],
            'loopback' => ['https://127.0.0.1'],
            'unspecified' => ['https://0.0.0.0'],
            'x.localhost with a port' => ['http://x.localhost:6379'],
            // literals
            'metadata ip' => ['https://169.254.169.254'],
            'ecs metadata ip' => ['https://169.254.170.2'],
            'alibaba metadata' => ['https://100.100.100.200'],
            'link-local' => ['https://169.254.1.1'],
            'ipv6 link-local' => ['https://[fe80::1]'],
            'ipv6 loopback' => ['https://[::1]'],
            'ipv6 unspecified' => ['https://[::]'],
            'ipv6 unique-local' => ['https://[fc00::1]'],
            'ipv6 multicast' => ['https://[ff02::1]'],
            'mapped private' => ['https://[::ffff:10.0.0.1]'],
            'mapped loopback hex' => ['https://[::ffff:7f00:1]'],
            'nat64 private' => ['https://[64:ff9b::a00:1]'],
            '6to4 private' => ['https://[2002:a00:1::]'],
            'compatible loopback' => ['https://[::7f00:1]'],
            'cgnat' => ['https://100.64.0.1'],
            '172.16' => ['https://172.16.0.1'],
            '172.31' => ['https://172.31.255.255'],
            '192.168' => ['https://192.168.1.1'],
            'benchmarking' => ['https://198.18.0.1'],
            'multicast' => ['https://224.0.0.1'],
            'broadcast' => ['https://255.255.255.255'],
            'this network' => ['https://0.1.2.3'],
            // numeric spellings
            'short form' => ['https://127.1'],
            'hex octets' => ['https://0x7f.0.0.1'],
            'octal octets' => ['https://0177.0.0.1'],
            'leading zero' => ['https://010.0.0.5'],
            'five parts' => ['https://1.2.3.4.5'],
            'three parts' => ['https://10.1.2'],
            // names
            'localhost' => ['https://localhost'],
            'single label' => ['https://pizzasys'],
            'local suffix' => ['https://printer.local'],
            'internal suffix' => ['https://svc.internal'],
            'lan suffix' => ['https://nas.lan'],
            'metadata alias' => ['https://metadata'],
            'a name that rebinds to a private address' => ['https://rebind.example.test'],
            'a name that resolves to a private address' => ['https://internal-only.example.test'],
            'a name that resolves to loopback' => ['https://loopback.example.test'],
            'a name that resolves to metadata' => ['https://metadata.example.test'],
            'a name that resolves to a mapped private address' => ['https://mapped.example.test'],
            'a name that does not resolve' => ['https://nothing.example.test'],
            // syntax that parsers disagree about
            'userinfo trick' => ['https://auth.example.com@10.0.0.5'],
            'userinfo with credentials' => ['https://user:secret@auth.example.com'],
            'backslash trick' => ['https://auth.example.com\\@10.0.0.5'],
            'fragment trick' => ['https://10.0.0.5#@auth.example.com'],
            'query' => ['https://auth.example.com?x=1'],
            'space' => ['https://auth example.com'],
            'tab' => ["https://auth.example.com\t"],
            'newline' => ["https://auth.example.com\nHost: evil"],
            'unicode host' => ['https://exämple.com'],
            'percent encoded host' => ['https://auth%2eexample.com'],
            'underscore' => ['https://auth_portal.example.com'],
            'leading hyphen' => ['https://-auth.example.com'],
            'empty label' => ['https://auth..example.com'],
            'port 0' => ['https://auth.example.com:0'],
            'port too big' => ['https://auth.example.com:70000'],
            // schemes
            'ftp' => ['ftp://auth.example.com'],
            'javascript' => ['javascript:alert(1)'],
            'file' => ['file:///etc/passwd'],
            'gopher' => ['gopher://auth.example.com'],
            'no scheme' => ['auth.example.com'],
            'protocol relative' => ['//auth.example.com'],
            'empty' => [''],
            'plain http to a public host' => ['http://auth.example.com'],
            'plain http to a public ip' => ['http://8.8.8.8'],
            'too long' => ['https://'.str_repeat('a', 250).'.example.com'],
        ];
    }

    #[DataProvider('refusedHttpUrls')]
    public function test_everything_else_is_refused_by_default(string $url): void
    {
        $this->assertFalse($this->http($url)->ok, $url);
    }

    public function test_ip_literals_are_never_looked_up(): void
    {
        $this->http('https://8.8.8.8');
        $this->http('https://[2606:4700:4700::1111]');
        $this->http('https://10.0.0.5');
        $this->http('https://2852039166');

        $this->assertSame([], $this->resolver->lookups);
    }

    public function test_a_name_is_looked_up_once_and_every_answer_is_judged(): void
    {
        $target = $this->http('https://auth.example.com');

        $this->assertSame(['auth.example.com'], $this->resolver->lookups);
        $this->assertSame([FakeHostResolver::PUBLIC_ADDRESS], $target->addresses);
        $this->assertSame('auth.example.com', $target->host);
        $this->assertSame(443, $target->port);
        $this->assertSame('https', $target->scheme);
        $this->assertFalse($target->private);
    }

    public function test_default_ports(): void
    {
        $this->assertSame(443, $this->http('https://auth.example.com')->port);
        $this->assertSame(80, $this->http('http://portal.test')->port);
        $this->assertSame(8443, $this->http('https://auth.example.com:8443')->port);
        $this->assertSame(4222, $this->guard()->checkNatsUrl('nats://nats.example.com')->port);
    }

    public function test_the_reason_is_available_for_logs_but_it_is_just_a_code(): void
    {
        $this->assertSame('private_address', $this->http('https://internal-only.example.test')->reason);
        $this->assertSame('plain_http', $this->http('http://auth.example.com')->reason);
        $this->assertSame('malformed', $this->http('https://u:p@auth.example.com')->reason);
        $this->assertSame('unresolvable', $this->http('https://nothing.example.test')->reason);
        $this->assertNull($this->http('https://auth.example.com')->reason);
    }

    // ---- private-network deployments -------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string}>
     */
    public static function privateButLegitimateUrls(): array
    {
        return [
            'rfc1918' => ['https://10.0.0.5'],
            'loopback' => ['https://127.0.0.1:8200'],
            'http loopback' => ['http://127.0.0.1:8200'],
            'http ipv6 loopback' => ['http://[::1]:8200'],
            'localhost' => ['http://localhost:8200'],
            'x.localhost' => ['http://x.localhost:6379'],
            'single label (a Docker service)' => ['https://pizzasys'],
            'local suffix' => ['https://printer.local'],
            'cgnat' => ['https://100.64.0.1'],
            'unique-local' => ['https://[fc00::1]'],
            'a name on a private address' => ['https://internal-only.example.test'],
            'a name on loopback' => ['https://loopback.example.test'],
            'a name on a mapped private address' => ['https://mapped.example.test'],
            'a name with a public and a private answer' => ['https://rebind.example.test'],
        ];
    }

    #[DataProvider('privateButLegitimateUrls')]
    public function test_private_hosts_are_accepted_when_the_deployment_says_so(string $url): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertTrue($this->http($url)->ok, $url);
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function neverAcceptableUrls(): array
    {
        return [
            'metadata ip' => ['https://169.254.169.254'],
            'mapped metadata' => ['https://[::ffff:169.254.169.254]'],
            'aws ipv6 metadata' => ['https://[fd00:ec2::254]'],
            'alibaba metadata' => ['https://100.100.100.200'],
            'link-local' => ['https://169.254.1.1'],
            'ipv6 link-local' => ['https://[fe80::1]'],
            'unspecified' => ['https://0.0.0.0'],
            'ipv6 unspecified' => ['https://[::]'],
            'multicast' => ['https://224.0.0.1'],
            'metadata name' => ['https://metadata.google.internal.'],
            'metadata alias' => ['https://metadata'],
            'a name that resolves to metadata' => ['https://metadata.example.test'],
            'decimal ip' => ['https://2852039166'],
            'hex ip' => ['https://0xA9FEA9FE'],
            'short form' => ['https://127.1'],
            'userinfo trick' => ['https://auth.example.com@10.0.0.5'],
            'plain http to a public host' => ['http://auth.example.com'],
            'a name that does not resolve' => ['https://nothing.example.test'],
        ];
    }

    #[DataProvider('neverAcceptableUrls')]
    public function test_some_targets_stay_refused_even_with_private_hosts_enabled(string $url): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertFalse($this->http($url)->ok, $url);
    }

    public function test_local_development_allows_private_hosts_and_plain_http_anywhere(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        $this->assertTrue($this->http('http://127.0.0.1:8200')->ok);
        $this->assertTrue($this->http('https://10.0.0.5')->ok);
        $this->assertTrue($this->http('http://auth.example.com')->ok, 'plain http is fine in local development');
        $this->assertFalse($this->http('https://169.254.169.254')->ok);
        $this->assertFalse($this->http('https://2852039166')->ok);
    }

    public function test_plain_http_in_production_is_only_for_the_reserved_development_names(): void
    {
        $this->app->detectEnvironment(fn () => 'production');
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertTrue($this->http('http://localhost:8200')->ok);
        $this->assertTrue($this->http('http://127.0.0.1:8200')->ok);
        $this->assertTrue($this->http('http://[::1]:8200')->ok);
        $this->assertTrue($this->http('http://portal.test')->ok);
        $this->assertTrue($this->http('http://portal.localhost')->ok);
        $this->assertFalse($this->http('http://10.0.0.5')->ok);
        $this->assertFalse($this->http('http://pizzasys')->ok);
        $this->assertFalse($this->http('http://auth.example.com')->ok);
    }

    public function test_a_private_target_is_flagged_so_a_plaintext_nats_inside_a_docker_network_can_be_told_apart(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertTrue($this->http('https://10.0.0.5')->private);
        $this->assertTrue($this->http('https://pizzasys')->private);
        $this->assertTrue($this->http('https://rebind.example.test')->private);
        $this->assertFalse($this->http('https://auth.example.com')->private);
    }

    // ---- NATS -----------------------------------------------------------------------------------------------------

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
            'trailing slash' => ['nats://nats.example.com:4222/', true],
            'private ip' => ['nats://10.0.0.7:4222', false],
            'loopback' => ['nats://127.0.0.1:4222', false],
            'metadata' => ['nats://169.254.169.254:4222', false],
            'decimal ip' => ['nats://2130706433:4222', false],
            'mapped loopback' => ['nats://[::ffff:127.0.0.1]:4222', false],
            'single label' => ['nats://nats:4222', false],
            'http' => ['http://nats.example.com', false],
            'credentials in the url' => ['nats://user:pass@nats.example.com:4222', false],
            'path' => ['nats://nats.example.com:4222/x', false],
            'no host' => ['nats://', false],
            'bare host' => ['nats.example.com:4222', false],
            'a name on a private address' => ['nats://internal-only.example.test:4222', false],
        ];
    }

    #[DataProvider('natsUrls')]
    public function test_nats_addresses(string $url, bool $accepted): void
    {
        $this->assertSame($accepted, $this->guard()->checkNatsUrl($url)->ok, $url);
    }

    public function test_private_nats_hosts_follow_the_same_switch(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $this->assertTrue($this->guard()->checkNatsUrl('nats://10.0.0.7:4222')->ok);
        $this->assertTrue($this->guard()->checkNatsUrl('nats://nats:4222')->private);
        $this->assertFalse($this->guard()->checkNatsUrl('nats://169.254.169.254:4222')->ok);
    }

    // ---- classification and pinning ---------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string, 1: string}>
     */
    public static function classifications(): array
    {
        return [
            ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['93.184.216.34', 'public'], ['172.15.255.255', 'public'], ['172.32.0.1', 'public'],
            ['100.63.255.255', 'public'], ['100.128.0.1', 'public'], ['198.17.0.1', 'public'], ['198.20.0.1', 'public'], ['192.0.2.1', 'public'],
            ['10.0.0.1', 'private'], ['127.0.0.1', 'private'], ['127.255.255.254', 'private'], ['172.16.0.1', 'private'], ['192.168.0.1', 'private'], ['100.64.0.1', 'private'], ['100.127.255.255', 'private'], ['198.18.0.1', 'private'], ['198.19.255.255', 'private'],
            ['0.0.0.0', 'blocked'], ['169.254.169.254', 'blocked'], ['169.254.0.1', 'blocked'], ['192.0.0.192', 'blocked'], ['224.0.0.1', 'blocked'], ['239.255.255.255', 'blocked'], ['240.0.0.1', 'blocked'], ['255.255.255.255', 'blocked'], ['100.100.100.200', 'blocked'],
            ['2606:4700:4700::1111', 'public'], ['2001:db8::1', 'public'], ['::ffff:8.8.8.8', 'public'], ['64:ff9b::808:808', 'public'], ['2002:808:808::', 'public'],
            ['::1', 'private'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['fec0::1', 'private'], ['::ffff:10.0.0.1', 'private'], ['::ffff:127.0.0.1', 'private'], ['64:ff9b::a00:1', 'private'],
            ['::', 'blocked'], ['fe80::1', 'blocked'], ['febf::1', 'blocked'], ['ff02::1', 'blocked'], ['fd00:ec2::254', 'blocked'], ['::ffff:169.254.169.254', 'blocked'], ['::ffff:0.0.0.0', 'blocked'], ['2002:a9fe:a9fe::', 'blocked'],
            ['not an ip', 'invalid'], ['', 'invalid'], ['1.2.3', 'invalid'], ['999.1.1.1', 'invalid'],
        ];
    }

    public function test_classification(): void
    {
        foreach (self::classifications() as [$address, $expected]) {
            $this->assertSame($expected, $this->guard()->classify($address), $address);
        }
    }

    public function test_the_validated_addresses_can_be_pinned_for_curl(): void
    {
        $this->resolver->map['two.example.test'] = ['93.184.216.34', '2606:4700:4700::1111'];

        $this->assertSame('auth.example.com:443:93.184.216.34', $this->http('https://auth.example.com')->curlResolveEntry());
        $this->assertSame('two.example.test:8443:93.184.216.34,[2606:4700:4700::1111]', $this->http('https://two.example.test:8443')->curlResolveEntry());
        $this->assertNull($this->http('https://8.8.8.8')->curlResolveEntry(), 'a literal needs no pinning');
        $this->assertNull($this->http('https://10.0.0.5')->curlResolveEntry(), 'a refused target is never pinned');
    }
}
