<?php

namespace App\Data\Auth;

use App\Auth\Tokens\StaffTokens;
use App\Domain\Widgets\Support\Timestamps;
use Laravel\Sanctum\PersonalAccessToken;
use Spatie\LaravelData\Data;

/**
 * One of a staff member's own API (bearer) tokens, as `GET /api/v1/auth/tokens` and `GET /api/v1/auth/me` show it. The token string
 * itself is never returned after sign-in (only its hash is stored); `id` is the number in front of the `|` of that string.
 */
class ApiTokenData extends Data
{
    /**
     * @param  list<string>  $abilities
     */
    public function __construct(
        public int $id,
        public string $name,
        public array $abilities,
        public ?string $lastUsedAt,
        public string $createdAt,
        public ?string $expiresAt,
        public bool $current,
    ) {}

    public static function fromModel(PersonalAccessToken $token, ?int $currentId = null, ?StaffTokens $tokens = null): self
    {
        $tokens ??= app(StaffTokens::class);

        return new self(
            id: (int) $token->getKey(),
            name: $token->name,
            abilities: array_values(array_map(strval(...), (array) $token->abilities)),
            lastUsedAt: Timestamps::iso($token->last_used_at),
            createdAt: (string) Timestamps::iso($token->created_at),
            expiresAt: Timestamps::iso($tokens->expiresAt($token)),
            current: $currentId !== null && (int) $token->getKey() === $currentId,
        );
    }
}
