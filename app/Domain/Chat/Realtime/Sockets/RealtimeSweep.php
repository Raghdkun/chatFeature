<?php

namespace App\Domain\Chat\Realtime\Sockets;

use App\Models\Conversation;
use App\Models\VisitorSession;

/**
 * `chat:realtime-sweep` (every minute): the part of the cut-off that does not hang on an event.
 *
 * 1. Works off the parked tags (`socket_cutoffs`): the follow-up of every cut and the retry of a call that failed.
 * 2. Closes the sockets of visitor sessions that were handed a subscription and are no longer valid (expired, or revoked by a path
 *    that raised no event), once each (`sockets_cut_at`).
 * 3. Judges the staff grants of conversations that changed in the last minutes again (a lost or failed event only delays the cut-off).
 * 4. Prunes old grants.
 *
 * Safe to run by hand and to run twice.
 */
final class RealtimeSweep
{
    /** Visitor sessions handled per run; a backlog (a long outage of the scheduler) is worked off over several runs. */
    private const VISITOR_BATCH = 200;

    public function __construct(
        private readonly SocketCutOff $cutoff,
        private readonly ConversationGrants $grants,
    ) {}

    /**
     * @return array{terminated: int, failed: int, dropped: int, visitor_sessions: int, staff_cut: int, grants_pruned: int}
     */
    public function run(): array
    {
        $parked = $this->cutoff->workOff();
        $visitorSessions = $this->cutExpiredVisitorSessions();
        $staffCut = 0;

        foreach ($this->grants->recentlyChangedConversationIds() as $conversationId) {
            $conversation = Conversation::query()->whereKey($conversationId)->first();

            if ($conversation !== null) {
                $staffCut += count($this->grants->revalidate($conversation));
            }
        }

        return [...$parked, 'visitor_sessions' => $visitorSessions, 'staff_cut' => $staffCut, 'grants_pruned' => $this->grants->prune()];
    }

    private function cutExpiredVisitorSessions(): int
    {
        $sessions = VisitorSession::query()
            ->whereNotNull('socket_authorized_at')
            ->whereNull('sockets_cut_at')
            ->where(fn ($ended) => $ended->whereNotNull('revoked_at')->orWhere('expires_at', '<=', now()))
            ->orderBy('id')
            ->limit(self::VISITOR_BATCH)
            ->get(['id']);

        foreach ($sessions as $session) {
            $this->cutoff->cutVisitorSession($session->id, 'expired');
        }

        if ($sessions->isNotEmpty()) {
            VisitorSession::query()->whereIn('id', $sessions->modelKeys())->update(['sockets_cut_at' => now()]);
        }

        return $sessions->count();
    }
}
