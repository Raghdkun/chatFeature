<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Base URL of an auth portal: an https URL, or http only for local development hosts (localhost, 127.0.0.1, ::1, *.test).
 * No credentials, query or fragment. Cloud metadata / link-local addresses are refused because the server calls this URL
 * with a bearer token.
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

        $scheme = strtolower($parts['scheme']);
        $host = strtolower(trim($parts['host'], '[]'));

        if (! in_array($scheme, ['http', 'https'], true)) {
            $fail(__('The portal address must start with https://.'));

            return;
        }

        if ($scheme === 'http' && ! $this->isLocalDevelopmentHost($host)) {
            $fail(__('Use https:// (plain http is only accepted for localhost, 127.0.0.1 and *.test).'));

            return;
        }

        if ($this->isMetadataHost($host)) {
            $fail(__('That address is not allowed.'));
        }
    }

    private function isLocalDevelopmentHost(string $host): bool
    {
        return in_array($host, ['localhost', '127.0.0.1', '::1'], true) || str_ends_with($host, '.test') || str_ends_with($host, '.localhost');
    }

    private function isMetadataHost(string $host): bool
    {
        if ($host === 'metadata.google.internal' || str_starts_with($host, '169.254.') || str_starts_with($host, 'fe80:')) {
            return true;
        }

        return false;
    }
}
