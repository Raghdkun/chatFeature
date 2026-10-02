<?php

namespace App\Domain\WhatsApp\Services;

use RuntimeException;

/**
 * An ack (`message.ack`, `message.failed`) arrived for a message this application does not know yet: the reply's `wa_message_id` is stored
 * a moment after OpenWA accepted it, and OpenWA's first ack can be faster. The delivery job tries again a little later; after the
 * schedule of `whatsapp.webhook.ack_retry_seconds` the ack is dropped (it belongs to a message the app never recorded).
 */
final class AckBeforeMessage extends RuntimeException {}
