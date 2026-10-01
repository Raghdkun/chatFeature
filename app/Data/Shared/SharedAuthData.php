<?php

namespace App\Data\Shared;

use App\Auth\Enums\AuthMode;
use App\Data\Auth\AuthCapabilitiesData;
use App\Data\Auth\AuthUserData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Inertia `auth` shared prop. */
#[TypeScript]
class SharedAuthData extends Data
{
    public function __construct(
        public ?AuthUserData $user,
        public AuthMode $mode,
        public AuthCapabilitiesData $capabilities,
    ) {}
}
