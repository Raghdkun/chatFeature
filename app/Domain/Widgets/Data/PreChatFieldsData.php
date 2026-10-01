<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.preChat.fields`. */
#[TypeScript]
class PreChatFieldsData extends Data
{
    public function __construct(
        public PreChatFieldData $name = new PreChatFieldData(enabled: true, required: true),
        public PreChatFieldData $email = new PreChatFieldData(enabled: true, required: false),
        public PreChatFieldData $phone = new PreChatFieldData(enabled: false, required: false),
    ) {}
}
