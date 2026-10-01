<?php

namespace App\Http\Controllers\Embed;

use App\Domain\Widgets\Config\ConfigResolver;
use App\Domain\Widgets\Embed\LoaderBundle;
use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Script delivery: `GET /w/{key}.js` (boot config inlined + loader) and `GET /widget/v1/loader.js` (generic loader).
 * Public, cookie-free, cacheable (`ETag`, `max-age=60`, `stale-while-revalidate=300`).
 */
class LoaderController extends Controller
{
    private const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

    public function widget(Request $request, string $key, PublicWidgetFinder $widgets, ConfigResolver $resolver, LoaderBundle $loader): Response
    {
        $widget = $widgets->find($key);

        if ($widget === null) {
            return $this->notFound();
        }

        $boot = $resolver->resolveArray($widget);

        $versioned = $boot;
        unset($versioned['generatedAt']);

        return $this->script(
            $request,
            $loader->forWidget($widget->public_key, $boot),
            sha1((string) json_encode($versioned).'|'.$loader->fingerprint()),
        );
    }

    public function generic(Request $request, LoaderBundle $loader): Response
    {
        return $this->script($request, $loader->generic(), sha1('generic|'.$loader->fingerprint()));
    }

    private function script(Request $request, string $code, string $etag): Response
    {
        $response = response($code, 200, [
            'Content-Type' => 'application/javascript; charset=utf-8',
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => self::CACHE_CONTROL,
        ]);
        $response->setEtag($etag);
        $response->isNotModified($request);

        return $response;
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
