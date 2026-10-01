<?php

namespace App\Support\Network;

/**
 * The real resolver: the system resolver (hosts file included, which is what curl and sockets use) for IPv4, plus
 * DNS A/AAAA records for the rest. The union is returned on purpose: if ANY address a name can reach is off limits the
 * target is refused, so a name that answers differently to different callers cannot slip through.
 */
final class DnsHostResolver implements HostResolver
{
    public function resolve(string $host): array
    {
        $addresses = [];

        $system = @gethostbynamel($host);

        foreach (is_array($system) ? $system : [] as $address) {
            $addresses[$address] = true;
        }

        $records = @dns_get_record($host, DNS_A | DNS_AAAA);

        foreach (is_array($records) ? $records : [] as $record) {
            $address = $record['ip'] ?? $record['ipv6'] ?? null;

            if (is_string($address) && $address !== '') {
                $addresses[$address] = true;
            }
        }

        return array_map('strval', array_keys($addresses));
    }
}
