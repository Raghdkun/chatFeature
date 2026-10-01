<?php

namespace App\Auth\Pizzasys;

use App\Infrastructure\Nats\NatsEndpoint;
use App\Infrastructure\Nats\TlsPolicy;
use App\Support\Network\OutboundUrlGuard;
use SensitiveParameter;

/**
 * A very small NATS handshake used only by the connection tests: connect, read the server's `INFO`, send `CONNECT`
 * (with the token) plus `PING` and expect `PONG`. It proves reachability and that the token is accepted without
 * pulling in the consumer's NATS client. The token is never echoed into a message.
 *
 * It is an outbound call to an address an administrator typed in, so it is hardened like one: the address goes through
 * {@see OutboundUrlGuard} first (public hosts only, unless private hosts are enabled), the socket goes to the address
 * that was validated, TLS follows {@see TlsPolicy} (certificate and host name verified; a plaintext session is refused
 * before the token is sent when TLS is required), every read is bounded in size and time, and EVERY failure produces
 * the same sentence, so the button cannot be used to find out what listens where.
 */
class NatsProbe
{
    public const TIMEOUT_SECONDS = 3;

    /** The longest line (INFO, PONG, -ERR) read from a server; a NATS INFO is a few hundred bytes. */
    public const MAX_LINE_BYTES = 16384;

    public function __construct(private readonly ?OutboundUrlGuard $guard = null) {}

    /**
     * @return array{ok: bool, message: string}
     */
    public function probe(string $url, #[SensitiveParameter] ?string $token, bool $verifyTls = true, ?string $caFile = null): array
    {
        $guard = $this->guard ?? app(OutboundUrlGuard::class);
        $target = $guard->checkNatsUrl($url);

        if (! $target->ok) {
            return $this->failed();
        }

        $endpoint = NatsEndpoint::parse($url);
        $caFile ??= config('nats.tls_ca_file');
        $policy = TlsPolicy::for($endpoint, $target, $verifyTls, is_string($caFile) ? $caFile : null);

        $addresses = $target->addresses;
        usort($addresses, fn (string $a, string $b): int => str_contains($a, ':') <=> str_contains($b, ':'));
        $address = $addresses[0] ?? $endpoint->host;
        $socketHost = str_contains($address, ':') ? '['.$address.']' : $address;

        $stream = @stream_socket_client('tcp://'.$socketHost.':'.$endpoint->port, $errorCode, $errorMessage, self::TIMEOUT_SECONDS);

        if ($stream === false) {
            return $this->failed();
        }

        try {
            return $this->handshake($stream, $token, $endpoint->tls, $policy);
        } finally {
            fclose($stream);
        }
    }

    /**
     * @param  resource  $stream  A connected stream whose first line is the server's INFO.
     * @return array{ok: bool, message: string}
     */
    public function handshake($stream, #[SensitiveParameter] ?string $token, bool $requireTls = false, ?TlsPolicy $policy = null): array
    {
        stream_set_timeout($stream, self::TIMEOUT_SECONDS);
        $deadline = microtime(true) + 2 * self::TIMEOUT_SECONDS;

        $info = $this->readLine($stream, $deadline);

        if ($info === null || ! str_starts_with($info, 'INFO ')) {
            return $this->failed();
        }

        $server = json_decode(substr($info, 5), true);
        $tlsOffered = $requireTls || (is_array($server) && ($server['tls_required'] ?? false) === true);

        // Never write the token in clear when TLS is demanded.
        if ($policy?->required === true && ! $tlsOffered) {
            return $this->failed();
        }

        if ($tlsOffered && ! $this->upgrade($stream, $policy)) {
            return $this->failed();
        }

        $connect = ['verbose' => false, 'pedantic' => false, 'lang' => 'php', 'version' => '1', 'protocol' => 1, 'tls_required' => $tlsOffered];

        if ($token !== null && $token !== '') {
            $connect['auth_token'] = $token;
        }

        if (@fwrite($stream, 'CONNECT '.json_encode($connect, JSON_UNESCAPED_SLASHES)."\r\nPING\r\n") === false) {
            return $this->failed();
        }

        $reply = $this->readLine($stream, $deadline);

        return $reply !== null && str_starts_with($reply, 'PONG')
            ? ['ok' => true, 'message' => __('NATS accepted the connection.')]
            : $this->failed();
    }

    /**
     * @param  resource  $stream
     */
    private function upgrade($stream, ?TlsPolicy $policy): bool
    {
        $verify = $policy->verifyPeer ?? true;

        stream_context_set_option($stream, 'ssl', 'verify_peer', $verify);
        stream_context_set_option($stream, 'ssl', 'verify_peer_name', $verify);
        stream_context_set_option($stream, 'ssl', 'allow_self_signed', false);
        stream_context_set_option($stream, 'ssl', 'SNI_enabled', true);

        if ($policy !== null) {
            stream_context_set_option($stream, 'ssl', 'peer_name', $policy->peerName);

            if ($policy->caFile !== null && is_file($policy->caFile) && is_readable($policy->caFile)) {
                stream_context_set_option($stream, 'ssl', 'cafile', $policy->caFile);
            }
        }

        return @stream_socket_enable_crypto($stream, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT) === true;
    }

    /**
     * One CRLF-terminated line of at most {@see MAX_LINE_BYTES}, or null on a timeout, a closed stream, an over-long
     * line or when the overall deadline has passed (a server that trickles bytes cannot hold the request up).
     *
     * @param  resource  $stream
     */
    private function readLine($stream, float $deadline): ?string
    {
        if (microtime(true) >= $deadline) {
            return null;
        }

        $line = stream_get_line($stream, self::MAX_LINE_BYTES + 1, "\r\n");

        if (! is_string($line) || strlen($line) > self::MAX_LINE_BYTES || microtime(true) > $deadline) {
            return null;
        }

        return $line;
    }

    /**
     * @return array{ok: false, message: string}
     */
    private function failed(): array
    {
        return ['ok' => false, 'message' => __('Could not establish a NATS session with that address. Check the address, the TLS setting and the token.')];
    }
}
