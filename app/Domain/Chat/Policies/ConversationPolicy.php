<?php

namespace App\Domain\Chat\Policies;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Models\Conversation;
use App\Models\User;

/**
 * Who may do what with a conversation (staff side; visitors are checked against their session with
 * `VisitorSession::owns()`). Registered for `Conversation` by `ChatServiceProvider`.
 *
 * - **See** (`view`, `viewAsStaff`): an active admin; the assigned agent; an agent holding an open offer while the chat is
 *   still `queued`; an agent serving the category of a queued offline ticket (a ticket without any category: every active agent). Everyone else: no. `viewAsStaff()` is the one
 *   rule the realtime channel authoriser reuses, and `Conversation::scopeVisibleTo()` is its query form.
 * - **Act** (`send`, `end`, `transfer`, `close`): an active admin or the assigned agent, and only while the status allows it.
 * - **Claim**: an active agent (`is_agent`) who may see the queued, unassigned chat. Category eligibility, presence and
 *   `max_concurrent_chats` are checked by the claim action itself (they need the database and the lock).
 *
 * `Gate::before` (AuthModeServiceProvider) grants every ability to an active admin, so `$user->can('claim', ...)` is always
 * true for admins and skips the state checks below: state-sensitive callers (the claim / send / end actions) must re-check
 * the status through the guarded SQL they run anyway, or call these methods directly on the policy.
 */
final class ConversationPolicy
{
    /** Staff with chat access may list conversations (the list itself is limited with `Conversation::visibleTo()`). */
    public function viewAny(User $user): bool
    {
        return $user->is_active && $user->hasChatAccess();
    }

    public function view(User $user, Conversation $conversation): bool
    {
        return $this->viewAsStaff($user, $conversation);
    }

    public function viewAsStaff(User $user, Conversation $conversation): bool
    {
        if (! $user->is_active) {
            return false;
        }

        if ($user->is_admin) {
            return true;
        }

        if (! $user->is_agent) {
            return false;
        }

        if ($conversation->assigned_agent_id === $user->id) {
            return true;
        }

        if ($conversation->status !== ConversationStatus::Queued) {
            return false;
        }

        return $conversation->isOfferedTo($user) || $this->servesOfflineTicket($user, $conversation);
    }

    public function claim(User $user, Conversation $conversation): bool
    {
        return $user->is_active
            && $user->is_agent
            && $conversation->status === ConversationStatus::Queued
            && $conversation->assigned_agent_id === null
            && $this->viewAsStaff($user, $conversation);
    }

    /** Write a message (also receipts and typing): an active chat, by its agent or an admin. */
    public function send(User $user, Conversation $conversation): bool
    {
        return $conversation->status === ConversationStatus::Active && $this->isParticipant($user, $conversation);
    }

    /** End a live chat (the visitor is asked to rate). */
    public function end(User $user, Conversation $conversation): bool
    {
        return $conversation->type === ConversationType::Live
            && $conversation->status === ConversationStatus::Active
            && $this->isParticipant($user, $conversation);
    }

    /** Hand the active chat to another agent or category. */
    public function transfer(User $user, Conversation $conversation): bool
    {
        return $conversation->status === ConversationStatus::Active && $this->isParticipant($user, $conversation);
    }

    /** Admin assignment of a queued or active conversation to a specific agent. */
    public function assign(User $user, Conversation $conversation): bool
    {
        return $user->is_active
            && $user->is_admin
            && in_array($conversation->status, [ConversationStatus::Queued, ConversationStatus::Active], true);
    }

    /** Resolve an offline ticket / dismiss a conversation without a rating: its agent, or an admin, until it is closed. */
    public function close(User $user, Conversation $conversation): bool
    {
        if ($conversation->status->isTerminal()) {
            return false;
        }

        // A queued conversation has no agent yet: only an admin can dismiss it.
        if ($conversation->status === ConversationStatus::Queued) {
            return $user->is_active && $user->is_admin;
        }

        return $this->isParticipant($user, $conversation);
    }

    /** Ratings (score, comment) are for administrators only. */
    public function viewRating(User $user, Conversation $conversation): bool
    {
        return $user->is_active && $user->is_admin;
    }

    private function isParticipant(User $user, Conversation $conversation): bool
    {
        if (! $user->is_active) {
            return false;
        }

        return $user->is_admin || ($user->is_agent && $conversation->assigned_agent_id === $user->id);
    }

    private function servesOfflineTicket(User $user, Conversation $conversation): bool
    {
        return $conversation->type === ConversationType::Offline
            && ($conversation->category_id === null || $user->categories()->whereKey($conversation->category_id)->exists());
    }
}
