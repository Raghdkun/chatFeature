<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.session`: server-side policy; mirrors `widgets.idle_timeout_minutes` (authoritative). */
#[TypeScript]
class SessionConfigData extends Data
{
    public function __construct(
        public int $idleTimeoutMinutes = 120,
    ) {}
}
