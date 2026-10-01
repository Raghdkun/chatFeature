<?php

namespace Tests\Unit\Chat;

use App\Domain\Chat\Enums\ConversationStatus;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The conversation state machine (plan section 6.3, docs/contracts/chat-data-p4.md). The whole table is spelled out here
 * on purpose: changing a transition must be a conscious edit of this test.
 */
class ConversationStatusTest extends TestCase
{
    private const TABLE = [
        'queued' => ['active', 'missed', 'closed'],
        'active' => ['ended', 'closed', 'queued'],
        'ended' => ['closed'],
        'missed' => [],
        'closed' => [],
    ];

    /**
     * @return iterable<string, array{string}>
     */
    public static function statuses(): iterable
    {
        foreach (ConversationStatus::cases() as $status) {
            yield $status->value => [$status->value];
        }
    }

    #[DataProvider('statuses')]
    public function test_allowed_transitions_match_the_documented_table(string $from): void
    {
        $allowed = array_map(
            static fn (ConversationStatus $status): string => $status->value,
            ConversationStatus::from($from)->allowedTransitions(),
        );

        $this->assertSame(self::TABLE[$from], $allowed);
    }

    #[DataProvider('statuses')]
    public function test_can_transition_to_agrees_with_the_table_for_every_pair(string $from): void
    {
        $from = ConversationStatus::from($from);

        foreach (ConversationStatus::cases() as $to) {
            $this->assertSame(
                in_array($to->value, self::TABLE[$from->value], true),
                $from->canTransitionTo($to),
                "{$from->value} -> {$to->value}",
            );
        }
    }

    public function test_a_status_never_transitions_to_itself(): void
    {
        foreach (ConversationStatus::cases() as $status) {
            $this->assertFalse($status->canTransitionTo($status), $status->value);
        }
    }

    public function test_the_table_covers_every_case(): void
    {
        $this->assertEqualsCanonicalizing(array_keys(self::TABLE), array_map(static fn (ConversationStatus $status): string => $status->value, ConversationStatus::cases()));
    }

    public function test_missed_and_closed_are_terminal_and_everything_else_is_not(): void
    {
        $this->assertTrue(ConversationStatus::Missed->isTerminal());
        $this->assertTrue(ConversationStatus::Closed->isTerminal());
        $this->assertFalse(ConversationStatus::Queued->isTerminal());
        $this->assertFalse(ConversationStatus::Active->isTerminal());
        $this->assertFalse(ConversationStatus::Ended->isTerminal());
    }

    public function test_only_queued_and_active_are_open(): void
    {
        $this->assertSame([ConversationStatus::Queued, ConversationStatus::Active], ConversationStatus::open());
        $this->assertSame(['queued', 'active'], ConversationStatus::openValues());
        $this->assertTrue(ConversationStatus::Queued->isOpen());
        $this->assertTrue(ConversationStatus::Active->isOpen());
        $this->assertFalse(ConversationStatus::Ended->isOpen());
        $this->assertFalse(ConversationStatus::Closed->isOpen());
        $this->assertFalse(ConversationStatus::Missed->isOpen());
    }

    public function test_every_status_is_reachable_from_queued(): void
    {
        $seen = [ConversationStatus::Queued];
        $frontier = [ConversationStatus::Queued];

        while ($frontier !== []) {
            $next = array_shift($frontier);

            foreach ($next->allowedTransitions() as $to) {
                if (! in_array($to, $seen, true)) {
                    $seen[] = $to;
                    $frontier[] = $to;
                }
            }
        }

        $this->assertCount(count(ConversationStatus::cases()), $seen);
    }
}
