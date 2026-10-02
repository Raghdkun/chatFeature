<?php

namespace App\Domain\Settings\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/** An integer that is 0 ("off", "keep for ever") or at least `$minimum`: a retention of 3 days is refused, 0 and 7 are not. */
final class ZeroOrAtLeast implements ValidationRule
{
    public function __construct(private readonly int $minimum) {}

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (is_numeric($value) && ((int) $value === 0 || (int) $value >= $this->minimum)) {
            return;
        }

        $fail(__('The retention is 0 (keep for ever) or at least :days days.', ['days' => $this->minimum]));
    }
}
