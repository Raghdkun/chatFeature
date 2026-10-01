<?php

namespace App\Http\Controllers\Embed;

use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\AppOrigin;
use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Controller;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * The iframe page of the chat panel (`GET /embed/{key}[?mode=inline&preview=1]`) and the hosted page (`GET /c/{key}`).
 * Both are Blade shells for `resources/js/embed/main.tsx`; neither sets cookies. Who may frame them is decided by
 * `Content-Security-Policy: frame-ancestors`: the widget's domains, `'self'` for the admin-only preview, `'none'` for the hosted page.
 */
class EmbedController extends Controller
{
    public function embed(Request $request, string $key, PublicWidgetFinder $widgets, OriginMatcher $origins, AppOrigin $origin): Response
    {
        $preview = $request->attributes->get('embed_preview') === true;
        $widget = $widgets->find($key, includeDisabled: $preview);

        abort_if($widget === null, 404);

        $hosts = $this->hosts($widget);
        $mode = $request->query('mode') === 'inline' ? 'inline' : 'launcher';

        return $this->page(
            $widget,
            $origin,
            mode: $mode,
            preview: $preview,
            allowedHosts: $hosts,
            frameAncestors: $preview ? "'self'" : $origins->frameAncestors($hosts),
        );
    }

    public function hosted(string $key, PublicWidgetFinder $widgets, AppOrigin $origin): Response
    {
        $widget = $widgets->find($key);

        abort_if($widget === null, 404);

        return $this->page($widget, $origin, mode: 'hosted', preview: false, allowedHosts: [], frameAncestors: "'none'");
    }

    /**
     * @param  list<string>  $allowedHosts
     */
    private function page(Widget $widget, AppOrigin $origin, string $mode, bool $preview, array $allowedHosts, string $frameAncestors): Response
    {
        $locale = $widget->locale;
        $language = strtolower(explode('-', $locale)[0]);

        $response = response()->view('embed', [
            'embed' => [
                'key' => $widget->public_key,
                'appOrigin' => $origin->url(),
                'allowedHosts' => $allowedHosts,
                'preview' => $preview,
                'mode' => $mode,
            ],
            'locale' => $locale,
            'direction' => in_array($language, (array) config('chat.rtl_locales', []), true) ? 'rtl' : 'ltr',
        ]);

        $response->headers->set('Content-Security-Policy', 'frame-ancestors '.$frameAncestors);
        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set('Cache-Control', $preview ? 'private, no-store' : 'public, max-age=60');

        return $response;
    }

    /**
     * @return list<string>
     */
    private function hosts(Widget $widget): array
    {
        return array_values($widget->domains->map(fn (WidgetDomain $domain): string => $domain->host)->all());
    }
}
