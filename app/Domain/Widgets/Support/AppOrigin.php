<?php

namespace App\Domain\Widgets\Support;

use App\Domain\Settings\SettingsRepository;

/**
 * The public origin of this installation (`scheme://host[:port]`, from the `app.url` setting): what snippets,
 * boot configs and postMessage origin checks point at. Taken from settings, never from the request, so a spoofed
 * Host header cannot poison cached responses.
 */
final class AppOrigin
{
    public function __construct(private readonly SettingsRepository $settings) {}

    public function url(): string
    {
        $configured = $this->settings->string('app.url', (string) config('app.url'));
        $parts = parse_url($configured);

        if ($parts === false || ! isset($parts['scheme'], $parts['host'])) {
            return 'http://localhost';
        }

        return strtolower($parts['scheme']).'://'.strtolower($parts['host']).(isset($parts['port']) ? ':'.$parts['port'] : '');
    }

    public function host(): string
    {
        return strtolower((string) parse_url($this->url(), PHP_URL_HOST));
    }
}
