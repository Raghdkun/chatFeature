<?php

namespace App\Domain\Chat\Realtime;

/**
 * Where the visitor panel opens its websocket: the Reverb app key and the PUBLIC address of the Reverb server (the `ws` block
 * of `POST /public/sessions`). Never the internal address the application publishes to (`broadcasting.connections.reverb.options`,
 * REVERB_PUBLISH_*), never the secret. Behind Caddy that is `REVERB_HOST` / `REVERB_PORT` / `REVERB_SCHEME` (for example
 * `chat.example.com`, 443, `https`), while the Reverb process listens on `REVERB_SERVER_HOST` / `REVERB_SERVER_PORT`.
 */
final class ReverbEndpoint
{
    /**
     * @return array{key: string, host: string, port: int, scheme: string}
     */
    public function forVisitors(): array
    {
        $scheme = strtolower((string) config('reverb.apps.apps.0.options.scheme', 'https'));
        $scheme = $scheme === 'http' ? 'http' : 'https';
        $port = (int) config('reverb.apps.apps.0.options.port', $scheme === 'https' ? 443 : 80);

        return [
            'key' => (string) config('broadcasting.connections.reverb.key', ''),
            'host' => (string) config('reverb.apps.apps.0.options.host', ''),
            'port' => $port > 0 && $port <= 65535 ? $port : ($scheme === 'https' ? 443 : 80),
            'scheme' => $scheme,
        ];
    }

    /**
     * Whether realtime can work at all: the application broadcasts through Reverb (not the `null` / `log` fallback used before the
     * install and when Reverb is not configured) and the clients have a key and a host to connect to. Callers leave the `ws` block
     * out when this is false; the panel then stays on REST (`GET …/messages?after_seq=`).
     */
    public function isAvailable(): bool
    {
        $endpoint = $this->forVisitors();

        return config('broadcasting.default') === 'reverb' && $endpoint['key'] !== '' && $endpoint['host'] !== '';
    }
}
