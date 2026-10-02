<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What the numbers cover. `role` is the caller's view (an agent only ever sees their own numbers and no WhatsApp); `dimension` / `key`
 * say which rows were read: `total`, or one `widget` / `category` (ulid, `0` for chats without a topic) / `agent` (user id).
 */
#[TypeScript]
class AnalyticsScopeData extends Data
{
    public function __construct(
        public string $role,
        public string $dimension,
        public ?string $key,
        public bool $whatsapp,
    ) {}
}
