<?php

namespace App\Http\Controllers\Embed;

use App\Domain\Widgets\Config\ConfigResolver;
use App\Domain\Widgets\Embed\LoaderBundle;
use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\AppOrigin;
use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Controller;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Script delivery: `GET /w/{key}.js` (boot config inlined + loader) and `GET /widget/v1/loader.js` (generic loader).
 * Public, cookie-free, cacheable (`ETag`, `max-age=60`, `stale-while-revalidate=300`).
 */
class LoaderController extends Controller
{
    private const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

    public function widget(
        Request $request,
        string $key,
        PublicWidgetFinder $widgets,
        ConfigResolver $resolver,
        LoaderBundle $loader,
        OriginMatcher $origins,
        AppOrigin $appOrigin,
    ): Response {
        $widget = $widgets->find($key);

        if ($widget === null) {
            return $this->notFound();
        }

        // A script tag cannot be CORS-gated, but browsers send the embedding page as `Referer`: a site that is not on the
        // widget's domain list does not get the branded bubble / greeting (the chat and the API refuse it anyway). A request
        // without a Referer (privacy settings, `Referrer-Policy: no-referrer`) cannot be judged and is served.
        $referrer = $origins->originFromUrl($request->headers->get('Referer'));

        if ($referrer !== null && ! $this->referrerAllowed($referrer, $widget, $origins, $appOrigin)) {
            return $this->forbidden();
        }

        $boot = $resolver->resolveArray($widget);

        $versioned = $boot;
        unset($versioned['generatedAt']);

        return $this->script(
            $request,
            $loader->forWidget($widget->public_key, $boot),
            sha1((string) json_encode($versioned).'|'.$loader->fingerprint()),
            varyReferer: true,
        );
    }

    public function generic(Request $request, LoaderBundle $loader): Response
    {
        return $this->script($request, $loader->generic(), sha1('generic|'.$loader->fingerprint()));
    }

    private function script(Request $request, string $code, string $etag, bool $varyReferer = false): Response
    {
        $response = response($code, 200, [
            'Content-Type' => 'application/javascript; charset=utf-8',
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => self::CACHE_CONTROL,
        ]);

        if ($varyReferer) {
            // The answer depends on who embeds it: shared caches must not hand one site's copy to another.
            $response->headers->set('Vary', 'Referer');
        }

        $response->setEtag($etag);
        $response->isNotModified($request);

        return $response;
    }

    private function referrerAllowed(string $referrer, Widget $widget, OriginMatcher $origins, AppOrigin $appOrigin): bool
    {
        $domains = $widget->domains->map(fn (WidgetDomain $domain): string => $domain->host);

        return $origins->matches($referrer, $domains) || strtolower($referrer) === $appOrigin->url();
    }

    private function forbidden(): Response
    {
        return response('/* pne-chat: this website is not on the widget\'s allowed domain list */ console.warn("PNE Chat: this website is not allowed to use this widget.");', 403, [
            'Content-Type' => 'application/javascript; charset=utf-8',
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'no-store',
            'Vary' => 'Referer',
        ]);
    }

    private function notFound(): Response
    {
        return response('/* widget not found */', 404, [
            'Content-Type' => 'application/javascript; charset=utf-8',
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'no-store',
        ]);
    }
}
