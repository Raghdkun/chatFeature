<?php

namespace App\Infrastructure\Nats;

use App\Support\Network\OutboundTarget;

/**
 * What a NATS session must look like on the wire, decided once from the address and the environment settings.
 *
 *  - `required`: a plaintext session is refused. True for a `tls://` address; and for a `nats://` address whenever
 *    certificate verification is on (`verify_tls`) and the server is not on a private network. A server that does not
 *    offer TLS then fails the connection BEFORE the token is sent (the library would otherwise send it in clear, and an
 *    on-path attacker could strip the server's TLS offer). A plain `nats://` to a private-network host with
 *    verification on stays allowed, because that is how a NATS inside a Docker network or a VPN is usually run.
 *  - `verifyPeer`: the server certificate and host name are checked (CA file from `NATS_TLS_CA_FILE`, else the system
 *    store). Off only when the administrator switched `verify_tls` off.
 *  - `peerName`: the host name the certificate must be valid for, also when the connection itself goes to a pinned IP.
 */
final readonly class TlsPolicy
{
    public function __construct(
        public bool $required,
        public bool $verifyPeer,
        public string $peerName,
        public ?string $caFile = null,
    ) {}

    public static function for(NatsEndpoint $endpoint, OutboundTarget $target, bool $verifyTls, ?string $caFile): self
    {
        $required = $endpoint->tls || ($verifyTls && ! $target->private);

        return new self($required, $verifyTls, $endpoint->host, $caFile !== null && trim($caFile) !== '' ? trim($caFile) : null);
    }
}
