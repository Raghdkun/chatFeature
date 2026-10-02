<?php

namespace App\Data\Shared;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What the dashboard needs to subscribe the browser to web push: the public VAPID key (never the private one). The shared `push` prop
 * is null when the keys are not configured, which switches the whole feature off in the page.
 */
#[TypeScript]
class PushConfigData extends Data
{
    public function __construct(
        public string $vapidPublicKey,
    ) {}
}
