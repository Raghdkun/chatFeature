<?php

namespace Tests\Unit\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\PresenceRecord;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The effective-status rules of decision P5-D2, every row of the matrix: manual choice wins, 90 s of silence = offline (a heartbeat 90 s
 * old still counts), hidden tabs for 5 minutes = away (exactly 5 minutes already counts), a visible heartbeat = online again, an
 * `offline` choice is never turned on by anything.
 */
class PresencePolicyTest extends TestCase
{
    private const NOW = '2026-10-01 12:00:00';

    private function now(): CarbonImmutable
    {
        return CarbonImmutable::parse(self::NOW, 'UTC');
    }

    private function record(PresenceStatus $status, bool $manual, ?int $heartbeatAge, ?int $visibleAge): PresenceRecord
    {
        return new PresenceRecord(
            userId: 1,
            status: $status,
            manual: $manual,
            heartbeatAt: $heartbeatAge === null ? null : $this->now()->subSeconds($heartbeatAge),
            visibleAt: $visibleAge === null ? null : $this->now()->subSeconds($visibleAge),
        );
    }

    /**
     * @return array<string, array{0: PresenceStatus, 1: bool, 2: int|null, 3: int|null, 4: PresenceStatus}>
     */
    public static function matrix(): array
    {
        $on = PresenceStatus::Online;
        $away = PresenceStatus::Away;
        $off = PresenceStatus::Offline;

        return [
            // Manual (pinned): the choice wins while heartbeats keep coming, visible or not.
            'manual online, visible' => [$on, true, 10, 10, $on],
            'manual online, hidden for 20 minutes' => [$on, true, 10, 1_200, $on],
            'manual online, heartbeat 90 s old' => [$on, true, 90, 90, $on],
            'manual online, heartbeat 91 s old' => [$on, true, 91, 91, $off],
            'manual away, visible' => [$away, true, 0, 0, $away],
            'manual away, hidden' => [$away, true, 30, 3_600, $away],
            'manual away, silent' => [$away, true, 91, 91, $off],
            'manual offline, fresh heartbeat' => [$off, true, 0, 0, $off],
            'manual online, never a heartbeat' => [$on, true, null, null, $off],

            // Automatic online: follows the dashboard.
            'automatic, visible' => [$on, false, 5, 5, $on],
            'automatic, hidden for 4:59' => [$on, false, 5, 299, $on],
            'automatic, hidden for exactly 5:00' => [$on, false, 5, 300, $away],
            'automatic, hidden for 5:01' => [$on, false, 5, 301, $away],
            'automatic, hidden for an hour' => [$on, false, 30, 3_600, $away],
            'automatic, visible again after a long hidden spell' => [$on, false, 0, 0, $on],
            'automatic, hidden but silent for 91 s' => [$on, false, 91, 400, $off],
            'automatic, heartbeat 90 s old and visible' => [$on, false, 90, 90, $on],
            'automatic, no visible beat on file counts as visible at the heartbeat' => [$on, false, 10, null, $on],
            'automatic, never a heartbeat' => [$on, false, null, null, $off],

            // Stored status that is not `online`.
            'stored away without a pin' => [$away, false, 10, 10, $away],
            'stored offline without a pin' => [$off, false, 0, 0, $off],
        ];
    }

    #[DataProvider('matrix')]
    public function test_the_effective_status(PresenceStatus $status, bool $manual, ?int $heartbeatAge, ?int $visibleAge, PresenceStatus $expected): void
    {
        $policy = new PresencePolicy(90, 5);

        $this->assertSame($expected, $policy->effective($this->record($status, $manual, $heartbeatAge, $visibleAge), $this->now()));
    }

    public function test_no_record_is_offline(): void
    {
        $this->assertSame(PresenceStatus::Offline, (new PresencePolicy)->effective(null, $this->now()));
    }

    public function test_auto_away_can_be_turned_off(): void
    {
        $policy = new PresencePolicy(90, 0);

        $this->assertSame(PresenceStatus::Online, $policy->effective($this->record(PresenceStatus::Online, false, 5, 86_400), $this->now()));
    }

    public function test_the_windows_come_from_the_configuration(): void
    {
        $policy = new PresencePolicy(120, 10);

        $this->assertSame(PresenceStatus::Online, $policy->effective($this->record(PresenceStatus::Online, false, 120, 599), $this->now()));
        $this->assertSame(PresenceStatus::Away, $policy->effective($this->record(PresenceStatus::Online, false, 5, 600), $this->now()));
        $this->assertSame(PresenceStatus::Offline, $policy->effective($this->record(PresenceStatus::Online, true, 121, 121), $this->now()));
        $this->assertSame(240, $policy->lifetimeSeconds());
    }

    public function test_the_activity_of_a_record_is_its_latest_sign_of_life(): void
    {
        $record = new PresenceRecord(1, PresenceStatus::Offline, true, $this->now()->subMinute(), null, $this->now()->subSeconds(10));

        $this->assertSame($this->now()->subSeconds(10)->getTimestamp(), $record->activityAt()?->getTimestamp());
        $this->assertNull((new PresenceRecord(1, PresenceStatus::Online, true))->activityAt());
    }
}
