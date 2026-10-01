<?php

namespace App\Domain\Widgets\Data;

use App\Models\WidgetGreeting;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One greeting of the pool as the loader sees it (`id` is the greeting's ulid; `body` is plain text). */
#[TypeScript]
class BootGreetingData extends Data
{
    public function __construct(
        public string $id,
        public string $body,
        public ?string $agentName,
        public ?string $agentAvatarUrl,
        public ?string $locale,
        public int $weight,
    ) {}

    public static function fromGreeting(WidgetGreeting $greeting): self
    {
        return new self(
            id: $greeting->ulid,
            body: $greeting->body,
            agentName: $greeting->agent_name,
            agentAvatarUrl: $greeting->agent_avatar_url,
            locale: $greeting->locale,
            weight: $greeting->weight,
        );
    }
}
