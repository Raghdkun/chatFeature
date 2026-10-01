<?php

namespace App\Domain\Chat\Realtime\Support;

use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Broadcasting\BroadcastException;
use Throwable;

/**
 * The Reverb broadcaster of this application: Laravel's Pusher broadcaster, except that a failed publish no longer carries the
 * request URL in its message. The Pusher client signs every publish in the query string (`auth_key`, `auth_signature`,
 * `body_md5`), the HTTP client puts that URL into its error text ("... for http://reverb:8080/apps/1/events?auth_signature=..."),
 * and the failure is reported to the log: a signed request must not end up in log files.
 */
final class RedactedReverbBroadcaster extends PusherBroadcaster
{
    public function broadcast(array $channels, $event, array $payload = []): void
    {
        try {
            parent::broadcast($channels, $event, $payload);
        } catch (Throwable $exception) {
            throw new BroadcastException(self::redact($exception->getMessage()));
        }
    }

    /** Everything after the `?` of a URL is dropped. */
    public static function redact(string $message): string
    {
        return (string) preg_replace('/\?[^\s"\')]*/', '?…', $message);
    }
}
