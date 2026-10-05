<?php

namespace App\Support\Security;

use App\Domain\Chat\Realtime\ReverbEndpoint;
use Illuminate\Foundation\Vite;
use Illuminate\Http\Request;
use Throwable;

/**
 * The Content-Security-Policy of the Inertia dashboard (docs/security.md "Content-Security-Policy").
 *
 * Derived from what the pages really load, not from a template:
 *
 * - `script-src 'self' 'nonce-…'`: the production build is same-origin files (the entry, its lazy chunks and their preloads); the only
 *   inline script is the appearance probe of `resources/views/app.blade.php`, and it carries the per-request nonce (so do the tags
 *   `@vite` / `@fonts` / `@viteReactRefresh` print: `Vite::useCspNonce()` is called before the view renders). No `unsafe-inline`, no
 *   `unsafe-eval`, no inline event handlers, no `strict-dynamic` (Vite's lazy-chunk preloads are plain `<link>` tags without a nonce).
 * - `style-src 'self' 'unsafe-inline'`: a considered choice, not a gap. Libraries of the bundle inject `<style>` elements at runtime without
 *   a nonce (sonner's toaster, react-style-singleton, Radix scroll areas, input-otp) and React sets `style` attributes; a strict
 *   `style-src` would leave the toasts and scrollbars unstyled. Inline styles cannot run script; the script policy is what stops XSS.
 * - `connect-src 'self'` plus the public Reverb address (`ws://` / `wss://`, from `ReverbEndpoint`, the same one the `realtime` shared prop
 *   hands the browser) and the configured application origin when it differs from the request's (signed attachment URLs are built on it).
 * - `style-src` / `font-src` / `connect-src` also name Google Fonts and Bunny Fonts: the only hosts a widget's custom font may come from, which the
 *   builder's preview loads and fetches (without them the preview cannot show the font and the console reports a violation on every builder load).
 * - `img-src 'self' data: blob: https:` (visitor attachments, agent avatars on any host, the pairing QR as a `data:` URL, upload previews
 *   as `blob:`), `font-src 'self' data:` (plus the font hosts above), `media-src 'self' data: blob:` (notification sounds), `worker-src 'self'` (`/sw.js`),
 *   `manifest-src 'self'`, `frame-src 'self'` (the widget builder's preview frames), `object-src 'none'`, `base-uri 'self'`,
 *   `form-action 'self'`, `frame-ancestors 'self'`, `upgrade-insecure-requests` only when the request came in over https.
 * - In development with the Vite dev server running (`public/hot`) its origin is added to the script / connect / font / image sources
 *   (with the `ws:` twin for hot reload) so `composer dev` keeps working.
 */
final class ContentSecurityPolicy
{
    /**
     * The only hosts a widget's custom font stylesheet may come from (`WidgetConfigValidator`), and where their font files live. The
     * builder's live preview loads that stylesheet inside a frame that inherits this policy, so these (and nothing else) are allowed.
     */
    private const FONT_STYLESHEET_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.bunny.net'];

    private const FONT_FILE_HOSTS = ['https://fonts.gstatic.com', 'https://fonts.bunny.net'];

    public function __construct(
        private readonly ReverbEndpoint $reverb,
        private readonly Vite $vite,
    ) {}

    public function build(Request $request, string $nonce): string
    {
        $self = ["'self'"];
        $scripts = [...$self, "'nonce-".$nonce."'"];
        $connect = $self;
        $images = [...$self, 'data:', 'blob:', 'https:'];
        $fonts = [...$self, 'data:', ...self::FONT_FILE_HOSTS];

        foreach ($this->applicationOrigin($request) as $origin) {
            $images[] = $origin;
            $connect[] = $origin;
        }

        // The preview's loader FETCHES the widget's font stylesheet (and then applies it), which is a connection, not a style load.
        foreach (self::FONT_STYLESHEET_HOSTS as $origin) {
            $connect[] = $origin;
        }

        foreach ($this->websocketSources() as $source) {
            $connect[] = $source;
        }

        foreach ($this->devServerOrigins() as $origin) {
            $scripts[] = $origin;
            $images[] = $origin;
            $fonts[] = $origin;
        }

        foreach ($this->devServerOrigins(connect: true) as $origin) {
            $connect[] = $origin;
        }

        $directives = [
            'default-src' => $self,
            'script-src' => $scripts,
            'style-src' => [...$self, "'unsafe-inline'", ...self::FONT_STYLESHEET_HOSTS, ...$this->devServerOrigins()],
            'img-src' => array_values(array_unique($images)),
            'font-src' => array_values(array_unique($fonts)),
            'connect-src' => array_values(array_unique($connect)),
            'media-src' => [...$self, 'data:', 'blob:'],
            'frame-src' => $self,
            'worker-src' => $self,
            'manifest-src' => $self,
            'object-src' => ["'none'"],
            'base-uri' => $self,
            'form-action' => $self,
            'frame-ancestors' => $self,
        ];

        $policy = [];

        foreach ($directives as $name => $sources) {
            $policy[] = $name.' '.implode(' ', $sources);
        }

        if ($request->isSecure()) {
            $policy[] = 'upgrade-insecure-requests';
        }

        $reportUri = $this->reportUri();

        if ($reportUri !== null) {
            $policy[] = 'report-uri '.$reportUri;
        }

        return implode('; ', $policy);
    }

    /**
     * The configured application origin when it is not the one this request came to (signed attachment URLs live on it).
     *
     * @return list<string>
     */
    private function applicationOrigin(Request $request): array
    {
        try {
            $configured = $this->origin(settings()->string('app.url', ''));
        } catch (Throwable) {
            // Before the install there is no settings table.
            $configured = null;
        }

        if ($configured === null) {
            $configured = $this->origin((string) config('app.url'));
        }

        return $configured !== null && $configured !== $request->getSchemeAndHttpHost() ? [$configured] : [];
    }

    /**
     * `ws://host:port` / `wss://host:port` of Reverb (default ports left out), nothing while realtime is not available.
     *
     * @return list<string>
     */
    private function websocketSources(): array
    {
        if (! $this->reverb->isAvailable()) {
            return [];
        }

        $endpoint = $this->reverb->forVisitors();
        $secure = $endpoint['scheme'] === 'https';
        $defaultPort = $secure ? 443 : 80;
        $host = $this->safeHost($endpoint['host']);

        if ($host === null) {
            return [];
        }

        return [($secure ? 'wss://' : 'ws://').$host.($endpoint['port'] === $defaultPort ? '' : ':'.$endpoint['port'])];
    }

    /**
     * The Vite dev server (only while `public/hot` exists), and with `$connect` also its websocket twin.
     *
     * @return list<string>
     */
    private function devServerOrigins(bool $connect = false): array
    {
        if (! $this->vite->isRunningHot()) {
            return [];
        }

        $hot = @file_get_contents($this->vite->hotFile());
        $origin = is_string($hot) ? $this->origin(trim($hot)) : null;

        if ($origin === null) {
            return [];
        }

        return $connect ? [$origin, preg_replace('/^http/', 'ws', $origin) ?? $origin] : [$origin];
    }

    private function reportUri(): ?string
    {
        $uri = trim((string) config('chat.security.csp_report_uri', ''));

        // Same-origin path only: a report is the page's address and a blocked URL, never sent to a third party by default.
        return $uri !== '' && str_starts_with($uri, '/') && ! str_starts_with($uri, '//') && preg_match('/^[\x21-\x7e]+$/D', $uri) === 1 && ! str_contains($uri, ';') && ! str_contains($uri, ',') ? $uri : null;
    }

    /** `scheme://host[:port]` of a URL, or null when it is not a plain http(s) origin. */
    private function origin(string $url): ?string
    {
        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = $this->safeHost((string) ($parts['host'] ?? ''));

        if (! in_array($scheme, ['http', 'https'], true) || $host === null) {
            return null;
        }

        return $scheme.'://'.$host.(isset($parts['port']) ? ':'.$parts['port'] : '');
    }

    /** A host that cannot smuggle another directive or source into the header (no whitespace, quotes, semicolons or commas). */
    private function safeHost(string $host): ?string
    {
        return preg_match('/^(\[[0-9a-f:.]+\]|[a-z0-9.*-]+)$/Di', $host) === 1 ? strtolower($host) : null;
    }
}
