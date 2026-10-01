<?php

namespace App\Auth\Shadow;

use App\Models\User;
use App\Models\UserExternalIdentity;

/** Outcome of {@see ShadowUserSync::upsert()}: the linked local account, or the reason it was refused. */
final readonly class ShadowSyncResult
{
    public const IDENTITY_DEACTIVATED = 'identity_deactivated';

    public const ACCOUNT_DEACTIVATED = 'account_deactivated';

    public const EMAIL_CONFLICT = 'email_conflict';

    public const NOT_CREATED = 'not_created';

    /** A new portal account shares its email with a local user that already has a live identity in this environment. */
    public const IDENTITY_CONFLICT = 'identity_conflict';

    private function __construct(
        public ?User $user,
        public ?UserExternalIdentity $identity,
        public bool $created,
        public ?string $refusal,
    ) {}

    public static function synced(User $user, UserExternalIdentity $identity, bool $created): self
    {
        return new self($user, $identity, $created, null);
    }

    public static function refused(string $reason, ?User $user = null): self
    {
        return new self($user, null, false, $reason);
    }

    public function isSynced(): bool
    {
        return $this->refusal === null && $this->user !== null && $this->identity !== null;
    }
}
