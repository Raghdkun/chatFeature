<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.features`: switches the dashboard controls (clients may only turn a feature off, never on). */
#[TypeScript]
class FeaturesConfigData extends Data
{
    public function __construct(
        public bool $attachments = true,
        public bool $rating = true,
        public bool $sounds = true,
        public bool $preChat = true,
        public bool $whatsapp = false,
        public bool $offlineForm = true,
        public bool $titleBadge = false,
        public bool $endChatByVisitor = true,
        public bool $poweredBy = true,
    ) {}
}
