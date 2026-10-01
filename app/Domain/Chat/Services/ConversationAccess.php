<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\User;

/**
 * Staff authorisation for the chat actions, through `ConversationPolicy` called directly (never `$user->can()`: `Gate::before`
 * grants every ability to an active admin, state checks included). A failure is `403 forbidden`; the state checks (is the chat
 * still active?) belong to the actions, which answer `409`.
 */
final class ConversationAccess
{
    public function __construct(private readonly ConversationPolicy $policy) {}

    /** The staff member may see the conversation at all (assigned agent, offered while queued, admin). */
    public function view(User $user, Conversation $conversation): void
    {
        if (! $this->policy->view($user, $conversation)) {
            throw $this->denied();
        }
    }

    /** Receipts and typing: only the agent the chat is assigned to (an admin watching a chat does not mark it read). */
    public function assignedAgent(User $user, Conversation $conversation): void
    {
        if (! $user->is_active || ! $user->is_agent || $conversation->assigned_agent_id !== $user->id) {
            throw $this->denied();
        }
    }

    /** Messages, ending, transferring, closing: the assigned agent, or an admin. */
    public function participant(User $user, Conversation $conversation): void
    {
        $allowed = $user->is_active && ($user->is_admin || ($user->is_agent && $conversation->assigned_agent_id === $user->id));

        if (! $allowed) {
            throw $this->denied();
        }
    }

    public function admin(User $user): void
    {
        if (! $user->is_active || ! $user->is_admin) {
            throw $this->denied();
        }
    }

    private function denied(): ApiProblemException
    {
        return ApiProblemException::forbidden('forbidden', __('This action is not allowed.'));
    }
}
