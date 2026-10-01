<?php

namespace App\Support\Network;

/**
 * The verdict of {@see OutboundUrlGuard} for one destination. `reason` is for logs and tests only and is never shown
 * to a user: what a person gets to see is the same sentence whichever check refused the address.
 */
final readonly class OutboundTarget
{
    /**
     * @param  list<string>  $addresses  The validated addresses of the host (the literal itself for an IP host).
     */
    public function __construct(
        public bool $ok,
        public string $scheme = '',
        public string $host = '',
        public int $port = 0,
        public array $addresses = [],
        public bool $ipLiteral = false,
        public bool $private = false,
        public ?string $reason = null,
    ) {}

    public static function blocked(string $reason): self
    {
        return new self(false, reason: $reason);
    }

    /** `host:port:address[,address]` for libcurl's CURLOPT_RESOLVE, so the connection goes where it was validated. */
    public function curlResolveEntry(): ?string
    {
        if (! $this->ok || $this->ipLiteral || $this->addresses === []) {
            return null;
        }

        $addresses = array_map(fn (string $address): string => str_contains($address, ':') ? '['.$address.']' : $address, $this->addresses);

        return $this->host.':'.$this->port.':'.implode(',', $addresses);
    }
}
