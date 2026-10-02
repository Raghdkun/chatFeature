<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What became of a webhook delivery from OpenWA (`wa_webhook_deliveries.outcome`; NULL while it is accepted and waiting for the
 * queue): `processed` (applied), `duplicate` (the idempotency key had been seen), `rejected` (refused before it was applied: bad
 * signature or malformed body), `ignored` (an event the application does not handle), `failed` (the job threw; `error` says why).
 */
#[TypeScript]
enum WebhookOutcome: string
{
    case Processed = 'processed';
    case Duplicate = 'duplicate';
    case Rejected = 'rejected';
    case Ignored = 'ignored';
    case Failed = 'failed';
}
