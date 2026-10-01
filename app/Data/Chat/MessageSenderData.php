<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\SenderType;
use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Who wrote a message. `id` (the staff user id of an agent sender) is present in staff payloads only: for visitors the key
 * is absent from the JSON altogether.
 */
#[TypeScript]
class MessageSenderData extends Data
{
    public function __construct(
        public SenderType $type,
        public ?string $name,
        public ?string $avatarUrl,
        public int|Optional $id = new Optional,
    ) {}
}
