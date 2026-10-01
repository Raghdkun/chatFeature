<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/** A NATS server address: `nats://host[:port]` or `tls://host[:port]` (credentials go in the separate token field). */
final class NatsUrl implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || preg_match('#^(nats|tls)://[A-Za-z0-9.\-]{1,200}(:\d{1,5})?$#', $value) !== 1) {
            $fail(__('Use a NATS address such as nats://host:4222 or tls://host:4222.'));
        }
    }
}
