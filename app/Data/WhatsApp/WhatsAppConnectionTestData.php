<?php

namespace App\Data\WhatsApp;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The answer of `POST /whatsapp/settings/test`: `ok` with the API key's `role` (`viewer | operator | admin`), the OpenWA `engine` and
 * `canOperate` (operator or admin: starting sessions and sending need it); or `ok: false` with a `reason` (`not_configured`, `blocked`,
 * `unreachable`, `unauthorized`, `rejected`, `unexpected_response`) and one sentence. `ok: true` with `reason: insufficient_role` says the
 * key can only read. Never carries the key or the address.
 */
#[TypeScript]
class WhatsAppConnectionTestData extends Data
{
    public function __construct(
        public bool $ok,
        public ?string $role,
        public ?string $engine,
        public bool $canOperate,
        public ?string $reason,
        public ?string $message,
    ) {}
}
