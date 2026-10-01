<?php

namespace App\Data\Widgets;

use App\Models\WidgetGreeting;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One greeting of a widget's pool as the builder edits it. */
#[TypeScript]
class GreetingData extends Data
{
    public function __construct(
        public string $ulid,
        public string $body,
        public ?string $agent_name,
        public ?string $agent_avatar_url,
        public ?string $locale,
        public int $weight,
        public bool $is_active,
        public int $sort_order,
    ) {}

    public static function fromGreeting(WidgetGreeting $greeting): self
    {
        return new self(
            ulid: $greeting->ulid,
            body: $greeting->body,
            agent_name: $greeting->agent_name,
            agent_avatar_url: $greeting->agent_avatar_url,
            locale: $greeting->locale,
            weight: $greeting->weight,
            is_active: $greeting->is_active,
            sort_order: $greeting->sort_order,
        );
    }
}
