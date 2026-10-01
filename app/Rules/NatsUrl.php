<?php

namespace App\Rules;

use App\Support\Network\OutboundUrlGuard;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * A NATS server address: `nats://host[:port]` or `tls://host[:port]` (credentials go in the separate token field).
 * Judged by {@see OutboundUrlGuard} like the portal address: public hosts only unless private hosts are enabled, only
 * canonical address spellings, one fixed message for every refusal.
 */
final class NatsUrl implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value)) {
            $fail(__('Use a NATS address such as nats://host:4222 or tls://host:4222.'));

            return;
        }

        $target = app(OutboundUrlGuard::class)->checkNatsUrl($value);

        if ($target->ok) {
            return;
        }

        $fail($target->reason === 'malformed'
            ? __('Use a NATS address such as nats://host:4222 or tls://host:4222.')
            : __('That address cannot be used. Enter the public address of the NATS server.'));
    }
}
