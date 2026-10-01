<?php

namespace App\Data\Shared;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Props every Inertia page receives from HandleInertiaRequests::share().
 * Contract: docs/contracts/inertia-shared-props.md (the `errors` bag is added by Inertia itself).
 */
#[TypeScript]
class SharedPropsData extends Data
{
    public function __construct(
        public string $name,
        public SharedAuthData $auth,
        public string $locale,
        public TextDirection $direction,
        public bool $installed,
        public bool $sidebarOpen,
        public FlashData $flash,
        public ?RealtimeEndpointData $realtime = null,
    ) {}
}
