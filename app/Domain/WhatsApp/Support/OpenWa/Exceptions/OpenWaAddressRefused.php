<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

/**
 * The saved OpenWA address was refused by the outbound guard right before the call (it points at a private network without
 * `PORTAL_ALLOW_PRIVATE_HOSTS`, at a metadata address, ...): nothing was sent. Which rule applied is never said.
 */
final class OpenWaAddressRefused extends OpenWaUnavailable {}
