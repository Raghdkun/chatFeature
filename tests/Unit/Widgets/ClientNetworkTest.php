<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Support\ClientNetwork;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class ClientNetworkTest extends TestCase
{
    /**
     * @return array<string, array{0: string|null, 1: string}>
     */
    public static function addresses(): array
    {
        return [
            'ipv4 stays itself' => ['203.0.113.9', '203.0.113.9'],
            'ipv6 becomes its /64' => ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
            'ipv6 compressed' => ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
            'ipv6 with another interface id' => ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
            'ipv6 loopback' => ['::1', '::/64'],
            'ipv4-mapped ipv6 is the ipv4 address' => ['::ffff:203.0.113.9', '203.0.113.9'],
            'garbage' => ['not an ip', 'unknown'],
            'empty' => ['', 'unknown'],
            'null' => [null, 'unknown'],
        ];
    }

    #[DataProvider('addresses')]
    public function test_addresses_collapse_into_rate_limit_buckets(?string $ip, string $expected): void
    {
        $this->assertSame($expected, ClientNetwork::bucket($ip));
    }

    public function test_two_hosts_of_one_ipv6_network_share_a_bucket_and_other_networks_do_not(): void
    {
        $this->assertSame(ClientNetwork::bucket('2001:db8:1:2::1'), ClientNetwork::bucket('2001:db8:1:2:abcd::9'));
        $this->assertNotSame(ClientNetwork::bucket('2001:db8:1:2::1'), ClientNetwork::bucket('2001:db8:1:3::1'));
    }
}
