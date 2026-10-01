<?php

namespace App\Infrastructure\Nats;

use Basis\Nats\Client;
use Basis\Nats\Configuration;
use Basis\Nats\Connection;
use Basis\Nats\Message\Info;
use Basis\Nats\Message\Prototype as Message;
use Closure;
use Psr\Log\LoggerInterface;

/**
 * basis-company/nats `Connection` with the TLS behaviour the library lacks:
 *
 *  - the library upgrades to TLS only when the server's first INFO says so, with the server certificate NOT verified
 *    unless a CA file is given and, even then, with the host name NOT checked, and it never refuses a plaintext
 *    session. Here the certificate and the host name are verified (CA file or the system store) and, when the
 *    {@see TlsPolicy} requires TLS, a server that does not offer it fails the connection before the CONNECT frame (with
 *    the token) is written;
 *  - the library's private socket / context are reached through scope-bound closures instead of copying its code; the
 *    two properties are stable across 1.x releases, and a missing one fails loudly rather than silently skipping TLS.
 *
 * Limitation: this is the library's own upgrade-after-INFO flow (STARTTLS style), so the INFO frame itself is always read
 * in clear; the policy makes that harmless by never sending a secret before TLS is up. NATS servers configured for
 * "TLS first" (handshake_first) are not supported.
 */
final class StrictTlsConnection extends Connection
{
    private bool $encrypted = false;

    private readonly Configuration $configuration;

    public function __construct(Client $client, private readonly TlsPolicy $policy, ?LoggerInterface $logger = null)
    {
        parent::__construct($client, $logger);

        $this->configuration = $client->configuration;
    }

    public function getMessage(null|int|float $timeout = 0): ?Message
    {
        $message = parent::getMessage($timeout);

        if ($message instanceof Info && $this->policy->required && ! $this->encrypted) {
            $this->close();

            throw new GatewayException('The NATS server does not offer TLS, which this connection requires.');
        }

        return $message;
    }

    protected function enableTls(bool $requireClientCert): void
    {
        // A later INFO (cluster updates) must not start a second handshake on an encrypted socket.
        if ($this->encrypted) {
            return;
        }

        [$context, $socket] = $this->privateState();

        if (! is_resource($socket) || ! is_resource($context)) {
            throw new GatewayException('The NATS connection is not open.');
        }

        if ($requireClientCert) {
            $this->setOption($context, 'local_pk', $this->configuration->tlsKeyFile);
            $this->setOption($context, 'local_cert', $this->configuration->tlsCertFile);
        }

        stream_context_set_option($context, 'ssl', 'verify_peer', $this->policy->verifyPeer);
        stream_context_set_option($context, 'ssl', 'verify_peer_name', $this->policy->verifyPeer);
        stream_context_set_option($context, 'ssl', 'allow_self_signed', false);
        // The name the certificate must be valid for (also the SNI name), even when the socket goes to a pinned address.
        stream_context_set_option($context, 'ssl', 'peer_name', $this->policy->peerName);
        stream_context_set_option($context, 'ssl', 'SNI_enabled', true);

        if ($this->policy->caFile !== null) {
            if (! is_file($this->policy->caFile) || ! is_readable($this->policy->caFile)) {
                throw new GatewayException('The NATS CA file cannot be read.');
            }

            stream_context_set_option($context, 'ssl', 'cafile', $this->policy->caFile);
        }

        $method = STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;

        if (@stream_socket_enable_crypto($socket, true, $method) !== true) {
            $this->close();

            // Deliberately terse: OpenSSL's text names the certificate subject and the failing check.
            throw new GatewayException('The NATS TLS handshake failed.');
        }

        $this->encrypted = true;
    }

    /**
     * @return array{0: mixed, 1: mixed} The parent's stream context and socket.
     */
    private function privateState(): array
    {
        return Closure::bind(fn (): array => [$this->context, $this->socket], $this, Connection::class)();
    }

    /**
     * @param  resource  $context
     */
    private function setOption($context, string $option, ?string $value): void
    {
        if ($value === null || $value === '') {
            return;
        }

        if (! file_exists($value)) {
            throw new GatewayException('A NATS TLS client file cannot be read.');
        }

        stream_context_set_option($context, 'ssl', $option, $value);
    }
}
