<?php

namespace App\Domain\Privacy;

/**
 * What an erasure (or a retention prune) removed: row counts only, never a name, an address or a word of a conversation. This is also what
 * the audit entry records.
 */
final class ErasureReport
{
    /**
     * @param  array<string, int>  $counts
     */
    public function __construct(
        public readonly bool $erased,
        public readonly array $counts = [],
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return ['erased' => $this->erased, ...$this->counts];
    }
}
