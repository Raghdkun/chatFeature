<?php

namespace App\Support\Network;

use Illuminate\Container\Attributes\Bind;

/**
 * Turns a host name into the IP addresses a connection to it could end up at. Injectable so tests never touch DNS.
 */
#[Bind(DnsHostResolver::class)]
interface HostResolver
{
    /**
     * @return list<string> Textual IPv4 / IPv6 addresses; empty when the name does not resolve.
     */
    public function resolve(string $host): array;
}
