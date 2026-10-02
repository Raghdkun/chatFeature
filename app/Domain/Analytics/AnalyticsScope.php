<?php

namespace App\Domain\Analytics;

use App\Data\Analytics\AnalyticsScopeData;
use App\Models\User;

/**
 * Which rows a request reads, decided on the server from WHO is asking (never from the client):
 *  - an administrator reads `total`, or at most one `widget` / `category` / `agent` row when they filter;
 *  - an agent only ever reads their own `agent` row, and never the `whatsapp` dimension.
 * `dimension` + `key` are the rollup row; `filterKey` is what the caller put in the URL (ulid / id) for echoing back.
 */
final class AnalyticsScope
{
    public function __construct(
        public readonly string $role,
        public readonly int $userId,
        public readonly string $dimension,
        public readonly string $key,
        public readonly ?string $filterKey = null,
    ) {}

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    /** Whether the numbers are one agent's (their own view, or an administrator looking at one agent). */
    public function isAgentDimension(): bool
    {
        return $this->dimension === AnalyticsColumns::AGENT;
    }

    public function canSeeWhatsApp(): bool
    {
        return $this->isAdmin();
    }

    public static function roleOf(User $user): ?string
    {
        if (! $user->is_active) {
            return null;
        }

        return match (true) {
            $user->is_admin => 'admin',
            $user->is_agent => 'agent',
            default => null,
        };
    }

    public function toData(): AnalyticsScopeData
    {
        return new AnalyticsScopeData($this->role, $this->dimension, $this->filterKey, $this->canSeeWhatsApp());
    }

    /** A stable string for cache keys: who asks (an agent's id matters, an admin's does not) and which row they read. */
    public function signature(): string
    {
        return $this->role.':'.($this->isAdmin() ? '' : $this->userId).':'.$this->dimension.':'.$this->key;
    }
}
