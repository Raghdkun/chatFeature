<?php

namespace Tests\Support;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Exceptions\PresenceStoreUnavailable;
use App\Domain\Presence\PresenceRecord;
use App\Domain\Presence\PresenceTransition;
use Carbon\CarbonInterface;
use RuntimeException;
use Throwable;

/** A presence store that answers like `$inner` while `$failure` is null and throws `$failure` otherwise; counts how often it was asked. */
final class FlakyPresenceStore implements PresenceStore
{
    public int $calls = 0;

    public ?Throwable $failure;

    public function __construct(private readonly PresenceStore $inner, ?Throwable $failure = null)
    {
        $this->failure = $failure;
    }

    /** The way Redis fails: the connection cannot be made. */
    public static function down(PresenceStore $inner): self
    {
        return new self($inner, PresenceStoreUnavailable::because(new RuntimeException('Connection refused')));
    }

    private function ask(): void
    {
        $this->calls++;

        if ($this->failure !== null) {
            throw $this->failure;
        }
    }

    public function find(int $userId, CarbonInterface $now): ?PresenceRecord
    {
        $this->ask();

        return $this->inner->find($userId, $now);
    }

    public function findMany(array $userIds, CarbonInterface $now): array
    {
        $this->ask();

        return $this->inner->findMany($userIds, $now);
    }

    public function choose(int $userId, PresenceStatus $status, bool $manual, CarbonInterface $now): PresenceTransition
    {
        $this->ask();

        return $this->inner->choose($userId, $status, $manual, $now);
    }

    public function beat(int $userId, bool $visible, CarbonInterface $now): PresenceTransition
    {
        $this->ask();

        return $this->inner->beat($userId, $visible, $now);
    }

    public function reconcile(int $userId, CarbonInterface $now): PresenceTransition
    {
        $this->ask();

        return $this->inner->reconcile($userId, $now);
    }

    public function forget(int $userId): void
    {
        $this->ask();
        $this->inner->forget($userId);
    }

    public function staleUserIds(CarbonInterface $now, int $limit): array
    {
        $this->ask();

        return $this->inner->staleUserIds($now, $limit);
    }

    public function announcedReachableUserIds(int $afterUserId, int $limit): array
    {
        $this->ask();

        return $this->inner->announcedReachableUserIds($afterUserId, $limit);
    }
}
