<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

/** No OpenWA API key (or address) is saved yet: nothing was sent anywhere. The administrator has to finish Settings > WhatsApp. */
final class OpenWaNotConfigured extends OpenWaUnavailable {}
