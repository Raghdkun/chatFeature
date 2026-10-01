<?php

namespace App\Rules;

use App\Support\Network\OutboundUrlGuard;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Base URL of an auth portal. The server calls this URL with a bearer token, so it is judged by
 * {@see OutboundUrlGuard}: an https URL (http only in local development or for localhost / 127.0.0.1 / ::1 / *.test /
 * *.localhost), no credentials, query or fragment, only canonical address spellings, and a host that resolves to public
 * addresses only unless private hosts are enabled (`PORTAL_ALLOW_PRIVATE_HOSTS`). Whatever the reason a host is refused
 * for, the message is the same.
 */
final class PortalUrl implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || $value === '' || mb_strlen($value) > 255) {
            $fail(__('Enter the portal address, for example https://auth.example.com.'));

            return;
        }

        $parts = parse_url($value);

        if ($parts === false || ! isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            $fail(__('Enter a plain address such as https://auth.example.com (no credentials, query or fragment).'));

            return;
        }

        if (! in_array(strtolower($parts['scheme']), ['http', 'https'], true)) {
            $fail(__('The portal address must start with https://.'));

            return;
        }

        $target = app(OutboundUrlGuard::class)->checkHttpUrl($value);

        if ($target->ok) {
            return;
        }

        $fail(match ($target->reason) {
            'plain_http' => __('Use https:// (plain http is only accepted for localhost, 127.0.0.1 and *.test).'),
            'malformed' => __('Enter a plain address such as https://auth.example.com (no credentials, query or fragment).'),
            default => __('That address cannot be used. Enter the public https address of the portal.'),
        });
    }
}
