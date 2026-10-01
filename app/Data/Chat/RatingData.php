<?php

namespace App\Data\Chat;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\Rating;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A visitor's rating of a conversation (`conversation` is its ulid). The visitor gets their own back; staff see it admin-only. */
#[TypeScript]
class RatingData extends Data
{
    public function __construct(
        public string $conversation,
        public int $score,
        public ?string $comment,
        public string $createdAt,
    ) {}

    public static function fromModel(Rating $rating): self
    {
        return new self(
            conversation: $rating->conversation->ulid,
            score: $rating->score,
            comment: $rating->comment,
            createdAt: (string) Timestamps::iso($rating->created_at),
        );
    }
}
