<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Models\AgentPresence;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;

/**
 * A staff member's presence: the single entry point for changing it and for reading what it is (decisions P5-D1..D3). The state itself
 * is in a `PresenceStore` (Redis, or the `agent_presence` table); `PresencePolicy` says what it means (manual choice, 90 s of silence,
 * auto-away).
 *
 * Every write and every sweep step ends in `announce()`: when the EFFECTIVE status really changed (and this call was the one that moved
 * it) `PresenceChanged` is dispatched once, and the cached public availability of the widgets the agent serves is dropped (it may flip
 * a widget's `online`). Routing, availability, `GET /me/presence`, the roster and the agents page read the same store, so they agree.
 */
final class PresenceService
{
    public function __construct(
        private readonly PresenceStore $store,
        private readonly PresencePolicy $policy,
        private readonly EffectivePresence $effective,
        private readonly AvailabilityService $availability,
    ) {}

    /** The stored record as an unsaved model, or a fresh `offline` one: the status the agent chose, not necessarily the effective one. */
    public function current(User $user): AgentPresence
    {
        return $this->store->find($user->id, now())?->toModel() ?? new AgentPresence(['user_id' => $user->id]);
    }

    /** What the status of a model is right now (silence, auto-away included). */
    public function effectiveStatus(?AgentPresence $presence): PresenceStatus
    {
        return $this->policy->effective($presence === null ? null : PresenceRecord::fromModel($presence), now());
    }

    public function statusOf(User|int $user): PresenceStatus
    {
        return $this->effective->of($user instanceof User ? $user->id : $user);
    }

    /**
     * @param  list<int>  $userIds
     * @return array<int, PresenceStatus> every id (one read for all of them)
     */
    public function statusesOf(array $userIds): array
    {
        return $this->effective->many($userIds);
    }

    /**
     * The status the dashboard starts from: what the agent chose while their record lives (so a reload revives it with the first
     * heartbeat), `offline` when the store has none.
     */
    public function chosenStatus(User $user): PresenceStatus
    {
        return $this->store->find($user->id, now())->status ?? PresenceStatus::Offline;
    }

    /**
     * The agent picks a status themselves (`PUT /me/presence`). `online` and `away` also count as a heartbeat. `$automatic` (only for
     * `online`) hands control back to the dashboard: `online` while a tab is visible, `away` after the auto-away minutes of hidden tabs;
     * any other choice is pinned and wins over auto-away.
     */
    public function set(User $user, PresenceStatus $status, bool $automatic = false): AgentPresence
    {
        $transition = $this->store->choose($user->id, $status, ! ($automatic && $status === PresenceStatus::Online), now());

        $this->announce($transition);

        return $this->modelOf($user, $transition);
    }

    /**
     * `POST /me/presence/heartbeat`: the dashboard is open. Refreshes an `online` / `away` status; it never turns an `offline` agent
     * online (only an explicit status change does). `$visible` = the tab is in the foreground.
     */
    public function heartbeat(User $user, bool $visible = true): AgentPresence
    {
        $transition = $this->store->beat($user->id, $visible, now());

        $this->announce($transition);

        return $this->modelOf($user, $transition);
    }

    /** The sweep's step for one user; announces a change exactly like a write does. */
    public function reconcile(int $userId): PresenceTransition
    {
        $transition = $this->store->reconcile($userId, now());

        $this->announce($transition);

        return $transition;
    }

    public function forget(User $user): void
    {
        $this->store->forget($user->id);
    }

    private function announce(PresenceTransition $transition): void
    {
        if (! $transition->changed()) {
            return;
        }

        PresenceChanged::dispatch($transition->userId, $transition->after);
        $this->forgetAvailabilityOf($transition->userId);
    }

    private function modelOf(User $user, PresenceTransition $transition): AgentPresence
    {
        return $transition->record?->toModel() ?? new AgentPresence(['user_id' => $user->id]);
    }

    /** A widget's `online` depends on which of its agents are reachable (and at which routing wave), so drop what was cached. */
    private function forgetAvailabilityOf(int $userId): void
    {
        $categoryIds = DB::table('category_user')->where('user_id', $userId)->pluck('category_id')->all();

        if ($categoryIds === []) {
            return;
        }

        Widget::query()
            ->whereHas('categories', fn ($categories) => $categories->whereIn('categories.id', $categoryIds))
            ->get()
            ->each(fn (Widget $widget) => $this->availability->forget($widget));
    }
}
