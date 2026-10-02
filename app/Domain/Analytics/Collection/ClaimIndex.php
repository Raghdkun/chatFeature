<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * Who claimed which conversation and when, read once per conversation from the append-only `claimed` events (the `conversations` row only
 * remembers the last claim, and its agent column is nulled when an account is deleted; the event keeps the id). Several collectors of one
 * run need it, so it caches per instance.
 */
final class ClaimIndex
{
    private const CHUNK = 500;

    /** @var array<int, array{first_id: int, first_at: int, first_actor: int|null, last_actor: int|null}|null> */
    private array $claims = [];

    /**
     * @param  iterable<int>  $conversationIds
     */
    public function load(iterable $conversationIds): void
    {
        $missing = [];

        foreach ($conversationIds as $id) {
            if (! array_key_exists($id, $this->claims)) {
                $missing[$id] = $id;
                $this->claims[$id] = null;
            }
        }

        foreach (array_chunk(array_values($missing), self::CHUNK) as $chunk) {
            $events = DB::table('conversation_events')
                ->where('type', 'claimed')
                ->whereIn('conversation_id', $chunk)
                ->orderBy('id')
                ->get(['id', 'conversation_id', 'actor_id', 'created_at']);

            foreach ($events as $event) {
                $id = (int) $event->conversation_id;
                $actor = $event->actor_id === null ? null : (int) $event->actor_id;
                $at = DayWindow::parseDb($event->created_at) ?? 0;

                $previous = $this->claims[$id];

                $this->claims[$id] = [
                    'first_id' => $previous === null ? (int) $event->id : $previous['first_id'],
                    'first_at' => $previous === null ? $at : $previous['first_at'],
                    'first_actor' => $previous === null ? $actor : $previous['first_actor'],
                    'last_actor' => $actor,
                ];
            }
        }
    }

    /**
     * @return array{first_id: int, first_at: int, first_actor: int|null, last_actor: int|null}|null
     */
    public function get(int $conversationId): ?array
    {
        return $this->claims[$conversationId] ?? null;
    }
}
