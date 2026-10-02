<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

/**
 * A write reached OpenWA's side of the connection, but no answer came back (a timeout after the request was sent, a connection
 * reset): the request may or may not have been carried out, so repeating it could do it twice (a customer would get a message
 * twice). A connection that never got through is a plain {@see OpenWaUnavailable}, which is safe to repeat.
 */
final class OpenWaRequestNotConfirmed extends OpenWaUnavailable {}
