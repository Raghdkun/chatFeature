<?php

namespace App\Rules;

use App\Support\Network\OutboundUrlGuard;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Base URL of the OpenWA gateway (`whatsapp.openwa.base_url`). The server calls it with the OpenWA API key, so it is judged by
 * {@see OutboundUrlGuard} like the auth portal: a plain `scheme://host[:port]` (no credentials, path, query or fragment), only canonical
 * address spellings, a host that resolves to public addresses only unless private hosts are allowed (`PORTAL_ALLOW_PRIVATE_HOSTS`, or
 * APP_ENV=local: OpenWA normally runs on loopback or a private Docker network), and never a metadata, link-local, multicast or
 * unspecified address. Plain `http` is accepted for a private or loopback target (the key never crosses the internet); a public host
 * needs `https`. Whatever the reason a host is refused for, the message is the same.
 */
final class OpenWaBaseUrl implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $message = __('Enter the address of OpenWA, for example http://127.0.0.1:2785 (private network addresses need the "allow private hosts" server setting).');

        if (! is_string($value) || $value === '' || mb_strlen($value) > 255 || preg_match('/[^\x21-\x7e]|[\\\\@#?]/', $value) === 1) {
            $fail($message);

            return;
        }

        $parts = parse_url($value);

        if ($parts === false || ! isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || (isset($parts['path']) && ! in_array($parts['path'], ['', '/'], true))) {
            $fail($message);

            return;
        }

        $scheme = strtolower($parts['scheme']);

        if (! in_array($scheme, ['http', 'https'], true)) {
            $fail($message);

            return;
        }

        $port = $parts['port'] ?? ($scheme === 'http' ? 80 : 443);
        $target = app(OutboundUrlGuard::class)->checkHost($parts['host'], $port, $scheme);

        if (! $target->ok) {
            $fail($message);

            return;
        }

        if ($scheme === 'http' && ! $target->private) {
            $fail(__('Use https:// for an OpenWA address on a public host (plain http is only accepted on a private network or loopback).'));
        }
    }
}
