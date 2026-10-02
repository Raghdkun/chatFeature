<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

use RuntimeException;

/**
 * OpenWA could not be asked or answered with something unusable: network failure, timeout, a 5xx, a body that is not what the API
 * documents, or no client configured at all. Transient from the caller's point of view: show "OpenWA is unreachable", retry later.
 */
class OpenWaUnavailable extends RuntimeException {}
