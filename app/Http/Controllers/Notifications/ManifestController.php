<?php

namespace App\Http\Controllers\Notifications;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

/**
 * `GET /manifest.webmanifest`: the web app manifest that lets the dashboard be installed (and, on iOS, receive web push: Safari only
 * delivers push to an installed web app). The name comes from the `app.name` setting, so it is generated, not a static file. Colours
 * match the theme (`--primary`, `--background` in resources/css/app.css); icons are the PNGs in `public/icons`.
 *
 * It sets no cookie and is cached for five minutes, so a renamed application shows its new name soon.
 */
class ManifestController extends Controller
{
    private const THEME_COLOR = '#005548';

    private const BACKGROUND_COLOR = '#f7fbfa';

    public function __invoke(): JsonResponse
    {
        $name = settings()->string('app.name', (string) config('app.name'));
        $locale = str_replace('_', '-', settings()->string('app.locale', (string) config('app.locale')));
        $rtl = in_array(strtolower(explode('-', $locale)[0]), (array) config('chat.rtl_locales', []), true);

        $manifest = [
            'id' => '/',
            'name' => $name,
            'short_name' => mb_substr($name, 0, 12),
            'description' => 'Live chat for support teams: accept chats and get notified of new requests.',
            'start_url' => '/dashboard',
            'scope' => '/',
            'display' => 'standalone',
            'orientation' => 'any',
            'lang' => $locale,
            'dir' => $rtl ? 'rtl' : 'ltr',
            'theme_color' => self::THEME_COLOR,
            'background_color' => self::BACKGROUND_COLOR,
            'categories' => ['business', 'productivity'],
            'icons' => [
                ['src' => '/icons/icon-192.png', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => '/icons/icon-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => '/icons/icon-maskable-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
            ],
        ];

        return response()
            ->json($manifest, 200, ['Content-Type' => 'application/manifest+json'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
            ->header('Cache-Control', 'public, max-age=300')
            ->header('X-Content-Type-Options', 'nosniff');
    }
}
