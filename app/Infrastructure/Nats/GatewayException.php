<?php

namespace App\Infrastructure\Nats;

use RuntimeException;

/**
 * Any failure talking to NATS/JetStream (connect, auth, API error, timeout, protocol). The consumer reacts
 * by reconnecting with backoff. Messages come from the client library and never contain event payloads.
 */
final class GatewayException extends RuntimeException {}
