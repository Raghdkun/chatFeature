<?php

namespace App\Domain\Widgets\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * An asset URL a widget may load: `https:` with a host and no userinfo, or a same-origin relative path (`/img/a.png`).
 * `http:`, `data:`, `javascript:`, protocol-relative (`//host`) and backslash tricks are refused.
 * With `$onlyHosts`, absolute URLs must point at one of those hosts (relative paths stay allowed: they are our own origin).
 */
final class SafeAssetUrl implements ValidationRule
{
    /**
     * @param  list<string>  $onlyHosts  lower-case hostnames; empty = any https host
     */
    public function __construct(private readonly array $onlyHosts = []) {}

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || ! $this->isAcceptable($value)) {
            $fail($this->onlyHosts === []
                ? 'The :attribute must be an https URL or a relative path starting with a single "/".'
                : 'The :attribute must be an https URL on an allowed host ('.implode(', ', $this->onlyHosts).') or a relative path.');
        }
    }

    public function isAcceptable(string $url): bool
    {
        if ($url === '' || strlen($url) > 2048 || preg_match('/[\s\x00-\x1f\x7f\\\\]/', $url) === 1) {
            return false;
        }

        if (str_starts_with($url, '/')) {
            return ! str_starts_with($url, '//');
        }

        $parts = parse_url($url);

        if ($parts === false || strtolower($parts['scheme'] ?? '') !== 'https' || ! isset($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            return false;
        }

        return $this->onlyHosts === [] || in_array(strtolower($parts['host']), $this->onlyHosts, true);
    }
}
