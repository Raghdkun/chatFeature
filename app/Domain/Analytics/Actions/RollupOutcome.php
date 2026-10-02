<?php

namespace App\Domain\Analytics\Actions;

/** What one day's rollup did (for the command's report and the tests). */
final class RollupOutcome
{
    public const ROLLED = 'rolled';

    public const SEALED = 'skipped: sealed';

    public function __construct(
        public readonly string $date,
        public readonly string $status,
        public readonly int $rows,
        public readonly bool $sealedNow = false,
        public readonly bool $whatsAppKept = false,
    ) {}

    public function wasRolled(): bool
    {
        return $this->status === self::ROLLED;
    }
}
