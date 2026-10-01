<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.preChat`: the form shown before a chat starts. A consent text gates "Start chat" behind a checkbox. */
#[TypeScript]
class PreChatConfigData extends Data
{
    public function __construct(
        public PreChatFieldsData $fields = new PreChatFieldsData,
        public ?string $consentText = null,
    ) {}
}
