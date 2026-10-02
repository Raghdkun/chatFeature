<?php

namespace App\Domain\Notifications\Support;

/**
 * A short human name for a browser ("Chrome on macOS") from its User-Agent, for the device list on the settings page. Best effort and
 * deliberately coarse: it only helps a person recognise which of their browsers a row is.
 */
final class DeviceLabel
{
    public static function fromUserAgent(?string $userAgent): string
    {
        $agent = (string) $userAgent;

        if ($agent === '') {
            return 'Browser';
        }

        $browser = match (true) {
            (bool) preg_match('~Edg(?:e|A|iOS)?/~', $agent) => 'Edge',
            (bool) preg_match('~OPR/|Opera~', $agent) => 'Opera',
            (bool) preg_match('~SamsungBrowser/~', $agent) => 'Samsung Internet',
            (bool) preg_match('~Firefox/|FxiOS/~', $agent) => 'Firefox',
            (bool) preg_match('~Chrome/|CriOS/|Chromium/~', $agent) => 'Chrome',
            (bool) preg_match('~Safari/~', $agent) => 'Safari',
            default => 'Browser',
        };

        $system = match (true) {
            (bool) preg_match('~iPhone|iPod~', $agent) => 'iPhone',
            (bool) preg_match('~iPad~', $agent) => 'iPad',
            (bool) preg_match('~Android~', $agent) => 'Android',
            (bool) preg_match('~Windows~', $agent) => 'Windows',
            (bool) preg_match('~Mac OS X|Macintosh~', $agent) => 'macOS',
            (bool) preg_match('~CrOS~', $agent) => 'ChromeOS',
            (bool) preg_match('~Linux|X11~', $agent) => 'Linux',
            default => null,
        };

        return $system === null ? $browser : $browser.' on '.$system;
    }
}
