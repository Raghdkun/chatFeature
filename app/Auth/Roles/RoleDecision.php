<?php

namespace App\Auth\Roles;

/** The chat roles a portal account maps to. Admins always take chats too, like in mode 1. */
final readonly class RoleDecision
{
    public function __construct(
        public bool $isAdmin,
        public bool $isAgent,
    ) {}

    public function hasChatAccess(): bool
    {
        return $this->isAdmin || $this->isAgent;
    }
}
