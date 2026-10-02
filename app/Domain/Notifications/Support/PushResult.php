<?php

namespace App\Domain\Notifications\Support;

/**
 * What one `PushChannel::deliver()` call achieved. `retry` lists the targets (subscription / token ids) that failed in a way worth
 * trying again (the push service was unreachable or answered 5xx / 429); a dead subscription (404 / 410) is `pruned`, a refusal that
 * will not change (bad key, payload too large, 403) is `failed`.
 */
final readonly class PushResult
{
    /**
     * @param  list<int>  $retry
     */
    public function __construct(
        public int $sent = 0,
        public int $pruned = 0,
        public int $failed = 0,
        public array $retry = [],
        public bool $disabled = false,
    ) {}

    public static function disabled(): self
    {
        return new self(disabled: true);
    }

    public function attempted(): int
    {
        return $this->sent + $this->pruned + $this->failed + count($this->retry);
    }

    /** Both results added up (several channels, or a retry on top). */
    public function merge(self $other): self
    {
        return new self(
            sent: $this->sent + $other->sent,
            pruned: $this->pruned + $other->pruned,
            failed: $this->failed + $other->failed,
            retry: [...$this->retry, ...$other->retry],
            disabled: $this->disabled && $other->disabled,
        );
    }
}
