<?php

namespace App\Auth\Pizzasys;

use SensitiveParameter;

/**
 * A very small NATS handshake used only by the connection tests: connect, read the server's `INFO`, send `CONNECT`
 * (with the token) plus `PING` and expect `PONG`. It proves reachability and that the token is accepted without
 * pulling in the consumer's NATS client. The token is never echoed into a message.
 */
class NatsProbe
{
    public const TIMEOUT_SECONDS = 3;

    /**
     * @return array{ok: bool, message: string}
     */
    public function probe(string $url, #[SensitiveParameter] ?string $token, bool $verifyTls = true): array
    {
        $parts = parse_url($url);
        $scheme = is_array($parts) ? ($parts['scheme'] ?? '') : '';
        $host = is_array($parts) ? ($parts['host'] ?? '') : '';
        $port = is_array($parts) ? (int) ($parts['port'] ?? 4222) : 4222;

        if (! in_array($scheme, ['nats', 'tls'], true) || $host === '') {
            return ['ok' => false, 'message' => __('Use a NATS address such as nats://host:4222.')];
        }

        $context = stream_context_create(['ssl' => ['verify_peer' => $verifyTls, 'verify_peer_name' => $verifyTls]]);
        $stream = @stream_socket_client('tcp://'.$host.':'.$port, $errorCode, $errorMessage, self::TIMEOUT_SECONDS, STREAM_CLIENT_CONNECT, $context);

        if ($stream === false) {
            return ['ok' => false, 'message' => __('Could not connect to NATS at :address.', ['address' => $host.':'.$port])];
        }

        try {
            return $this->handshake($stream, $token, $scheme === 'tls');
        } finally {
            fclose($stream);
        }
    }

    /**
     * @param  resource  $stream  A connected stream whose first line is the server's INFO.
     * @return array{ok: bool, message: string}
     */
    public function handshake($stream, #[SensitiveParameter] ?string $token, bool $requireTls = false): array
    {
        stream_set_timeout($stream, self::TIMEOUT_SECONDS);

        $info = fgets($stream);

        if (! is_string($info) || ! str_starts_with($info, 'INFO ')) {
            return ['ok' => false, 'message' => stream_get_meta_data($stream)['timed_out']
                ? __('NATS did not answer in time.')
                : __('The server on that port is not NATS.')];
        }

        $server = json_decode(substr($info, 5), true);
        $tlsRequired = $requireTls || (is_array($server) && ($server['tls_required'] ?? false) === true);

        if ($tlsRequired && ! @stream_socket_enable_crypto($stream, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            return ['ok' => false, 'message' => __('NATS requires TLS and the secure handshake failed.')];
        }

        $connect = ['verbose' => false, 'pedantic' => false, 'lang' => 'php', 'version' => '1', 'protocol' => 1, 'tls_required' => $tlsRequired];

        if ($token !== null && $token !== '') {
            $connect['auth_token'] = $token;
        }

        if (@fwrite($stream, 'CONNECT '.json_encode($connect, JSON_UNESCAPED_SLASHES)."\r\nPING\r\n") === false) {
            return ['ok' => false, 'message' => __('NATS closed the connection.')];
        }

        $reply = fgets($stream);

        if (! is_string($reply)) {
            return ['ok' => false, 'message' => __('NATS did not answer in time.')];
        }

        if (str_starts_with($reply, 'PONG')) {
            return ['ok' => true, 'message' => __('NATS accepted the connection.')];
        }

        if (stripos($reply, 'authorization') !== false || stripos($reply, 'authentication') !== false) {
            return ['ok' => false, 'message' => __('NATS rejected the credentials.')];
        }

        return ['ok' => false, 'message' => __('NATS refused the connection.')];
    }
}
