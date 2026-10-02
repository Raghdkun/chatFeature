<?php

namespace App\Domain\Chat\Realtime\Sockets;

use App\Models\PendingSocketCut;
use Carbon\CarbonInterface;
use Throwable;

/**
 * Closes the websockets of a principal whose right to them ended: a staff member who was deactivated, lost a role, signed out or
 * lost a conversation, a visitor session whose token was revoked, rotated away or expired.
 *
 * Authorisation happens when a client SUBSCRIBES, so an open socket keeps receiving until it is closed; closing it makes the client
 * reconnect and authorise again against the CURRENT state (the legitimate client gets back what it may still have, the revoked one
 * is refused). Reverb is asked through `SocketTerminator`. Two guarantees on top of the immediate call:
 *
 * - a call that fails (Reverb restarting, the network) is not lost: the tag is parked in `socket_cutoffs` and retried by
 *   `chat:realtime-sweep` with a growing pause, up to `MAX_ATTEMPTS` times;
 * - every cut is repeated once `FOLLOW_UP_SECONDS` later (the same table): a client whose authorisation was granted just before the
 *   state changed subscribes a few milliseconds AFTER the first call and would otherwise be missed.
 *
 * Nothing here ever throws: realtime is an add-on, a failure to cut is reported and the request that caused it carries on.
 */
final class SocketCutOff
{
    /** The follow-up that closes the "authorised, then state changed, then subscribed" window. */
    public const FOLLOW_UP_SECONDS = 20;

    public const MAX_ATTEMPTS = 6;

    /** Seconds before attempt N+1 of a call that failed N times. */
    private const BACKOFF_SECONDS = [5, 15, 60, 180, 600];

    public function __construct(private readonly SocketTerminator $terminator) {}

    public function cutStaff(int $userId, string $reason): void
    {
        $this->cut(SocketTags::allForStaff($userId), $reason);
    }

    public function cutVisitorSession(int $sessionId, string $reason): void
    {
        $this->cut([SocketTags::visitorSession($sessionId)], $reason);
    }

    /**
     * @param  list<string>  $tags
     */
    public function cut(array $tags, string $reason): void
    {
        $now = now();
        $parked = [];

        foreach (array_values(array_unique($tags)) as $tag) {
            $closed = $this->terminate($tag);

            $parked[] = $this->row($tag, $reason, $now, $closed ? self::FOLLOW_UP_SECONDS : self::BACKOFF_SECONDS[0], $closed ? 0 : 1);
        }

        try {
            if ($parked !== []) {
                PendingSocketCut::query()->insert($parked);
            }
        } catch (Throwable $exception) {
            report($exception);
        }
    }

    /**
     * Works off the parked tags that are due (the scheduled sweep): each tag is terminated once however many rows name it.
     *
     * @return array{terminated: int, failed: int, dropped: int}
     */
    public function workOff(int $limit = 200): array
    {
        $result = ['terminated' => 0, 'failed' => 0, 'dropped' => 0];
        $due = PendingSocketCut::query()->where('due_at', '<=', now())->orderBy('id')->limit($limit)->get();

        foreach ($due->groupBy('tag') as $tag => $rows) {
            $ids = $rows->pluck('id')->all();

            if ($this->terminate((string) $tag)) {
                PendingSocketCut::query()->whereIn('id', $ids)->delete();
                $result['terminated']++;

                continue;
            }

            $result['failed']++;

            foreach ($rows as $row) {
                $attempts = $row->attempts + 1;

                if ($attempts >= self::MAX_ATTEMPTS) {
                    $row->delete();
                    $result['dropped']++;
                    report(new \RuntimeException('A socket cut-off ('.$row->reason.') failed '.self::MAX_ATTEMPTS.' times and was given up.'));

                    continue;
                }

                $row->forceFill(['attempts' => $attempts, 'due_at' => now()->addSeconds(self::BACKOFF_SECONDS[min($attempts, count(self::BACKOFF_SECONDS)) - 1])])->save();
            }
        }

        return $result;
    }

    private function terminate(string $tag): bool
    {
        try {
            $this->terminator->terminate($tag);

            return true;
        } catch (Throwable $exception) {
            report($exception);

            return false;
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function row(string $tag, string $reason, CarbonInterface $now, int $dueInSeconds, int $attempts): array
    {
        return [
            'tag' => $tag,
            'reason' => mb_substr($reason, 0, 40),
            'attempts' => $attempts,
            'due_at' => $now->copy()->addSeconds($dueInSeconds),
            'created_at' => $now,
        ];
    }
}
