<?php

namespace App\Data\Notifications;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** What "Send a test notification" achieved: how many of the caller's devices the push services accepted, refused, or dropped as dead. */
#[TypeScript]
class PushTestResultData extends Data
{
    public function __construct(
        public int $devices,
        public int $sent,
        public int $failed,
        public int $removed,
    ) {}
}
