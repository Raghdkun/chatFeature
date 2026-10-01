<?php

namespace App\Domain\Visitors;

use App\Models\VisitorSession;

/**
 * A freshly created visitor session together with its plaintext bearer token. The plaintext exists only in this object:
 * hand it to the visitor once (`POST /public/widgets/{key}/sessions`) and drop it; only its sha256 is stored.
 */
final readonly class IssuedVisitorToken
{
    public function __construct(
        public string $plaintext,
        public VisitorSession $session,
    ) {}
}
