<?php

namespace App\Data\Auth;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The rows of a portal connection test. */
#[TypeScript]
enum PortalCheckKey: string
{
    case Reachable = 'reachable';
    case ServiceCredential = 'service_credential';
    case Latency = 'latency';
    case Nats = 'nats';
}
