<?php

namespace Tests\Support;

use App\Auth\Pizzasys\NatsProbe;
use SensitiveParameter;

/**
 * Stands in for the real NATS handshake in every test that is not about the probe itself, so a "Test connection" or a
 * pre-flight never opens a socket (a developer's local NATS on :4222 must not change a test's outcome).
 */
class FakeNatsProbe extends NatsProbe
{
    /** @var list<array{url: string, token: string|null, verify_tls: bool, ca_file: string|null}> */
    public array $probed = [];

    public function __construct(public bool $ok = true) {}

    /**
     * @return array{ok: bool, message: string}
     */
    public function probe(string $url, #[SensitiveParameter] ?string $token, bool $verifyTls = true, ?string $caFile = null): array
    {
        $this->probed[] = ['url' => $url, 'token' => $token, 'verify_tls' => $verifyTls, 'ca_file' => $caFile];

        return ['ok' => $this->ok, 'message' => $this->ok ? 'NATS accepted the connection.' : 'NATS did not accept the connection.'];
    }
}
