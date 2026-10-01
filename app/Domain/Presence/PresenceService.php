<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Models\AgentPresence;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonInterface;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * A staff member's presence, stored in `agent_presence` (P4). P5 puts Redis, auto-away and the sweep behind this class and
 * keeps the three REST endpoints (`GET/PUT /me/presence`, `POST /me/presence/heartbeat`).
 *
 * Routing counts an agent as reachable when the stored status is `online` or `away` AND the last heartbeat is younger than
 * `HEARTBEAT_TTL_SECONDS` (clients beat every 30 s): a closed tab drops out after 90 s even though nobody told us. The effective
 * status below applies the same rule, so what `GET /me/presence` says matches what routing does.
 *
 * `PresenceChanged` is dispatched when the effective status changes; the cached public availability of the widgets the agent
 * serves is dropped when the agent starts or stops being reachable (that can flip a widget's `online`).
 */
final class PresenceService
{
    /** A heartbeat older than this no longer counts as present. */
    public const HEARTBEAT_TTL_SECONDS = 90;

    public function __construct(private readonly AvailabilityService $availability) {}

    /** The stored row, or a fresh `offline` one that is not saved yet. */
    public function current(User $user): AgentPresence
    {
        return AgentPresence::query()->where('user_id', $user->id)->first() ?? new AgentPresence(['user_id' => $user->id]);
    }

    public function effectiveStatus(?AgentPresence $presence): PresenceStatus
    {
        if ($presence === null || ! $presence->status->isAvailable()) {
            return PresenceStatus::Offline;
        }

        return $this->isFresh($presence->last_heartbeat_at) ? $presence->status : PresenceStatus::Offline;
    }

    /** The agent picks a status themselves (`PUT /me/presence`). Going `online` or `away` also counts as a heartbeat. */
    public function set(User $user, PresenceStatus $status): AgentPresence
    {
        return $this->write($user, function (AgentPresence $presence) use ($status): void {
            $presence->status = $status;
            $presence->is_manual = true;
            $presence->forceFill(['last_seen_at' => now()]);

            if ($status->isAvailable()) {
                $presence->forceFill(['last_heartbeat_at' => now()]);
            }
        });
    }

    /**
     * `POST /me/presence/heartbeat`: the dashboard is open. Refreshes an `online` / `away` status; it never turns an `offline`
     * agent online (only an explicit status change does).
     */
    public function heartbeat(User $user): AgentPresence
    {
        return $this->write($user, function (AgentPresence $presence): void {
            $presence->forceFill(['last_seen_at' => now()]);

            if ($presence->status->isAvailable()) {
                $presence->forceFill(['last_heartbeat_at' => now()]);
            }
        });
    }

    /**
     * @param  callable(AgentPresence): void  $change
     */
    private function write(User $user, callable $change): AgentPresence
    {
        [$presence, $before] = $this->persist($user, $change);
        $after = $this->effectiveStatus($presence);

        if ($before !== $after) {
            PresenceChanged::dispatch($user->id, $after);

            if ($before->isAvailable() !== $after->isAvailable()) {
                $this->forgetAvailabilityOf($user);
            }
        }

        return $presence;
    }

    /**
     * Applies the change to the user's row (created on first use) and returns it with the effective status it had before.
     *
     * @param  callable(AgentPresence): void  $change
     * @return array{0: AgentPresence, 1: PresenceStatus}
     */
    private function persist(User $user, callable $change): array
    {
        for ($attempt = 1; ; $attempt++) {
            $presence = AgentPresence::query()->where('user_id', $user->id)->first();
            $before = $this->effectiveStatus($presence);
            $presence ??= new AgentPresence(['user_id' => $user->id]);

            $change($presence);

            try {
                $presence->save();
            } catch (UniqueConstraintViolationException $exception) {
                // Two first-time writes raced for the one row per user: read it again and apply the change to it.
                if ($attempt >= 2) {
                    throw $exception;
                }

                continue;
            }

            return [$presence, $before];
        }
    }

    private function forgetAvailabilityOf(User $user): void
    {
        $categoryIds = $user->categories()->pluck('categories.id')->all();

        if ($categoryIds === []) {
            return;
        }

        Widget::query()
            ->whereHas('categories', fn ($categories) => $categories->whereIn('categories.id', $categoryIds))
            ->get()
            ->each(fn (Widget $widget) => $this->availability->forget($widget));
    }

    private function isFresh(?CarbonInterface $heartbeat): bool
    {
        return $heartbeat !== null && $heartbeat->gte(now()->subSeconds(self::HEARTBEAT_TTL_SECONDS));
    }
}
