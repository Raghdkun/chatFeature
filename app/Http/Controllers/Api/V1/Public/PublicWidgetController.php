<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Http\Controllers\Controller;
use App\Models\Widget;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Base of the public widget endpoints: the widget was resolved and origin-checked by the `AuthorizeWidgetOrigin`
 * middleware; responses are cacheable and honour `If-None-Match`.
 */
abstract class PublicWidgetController extends Controller
{
    protected function widget(Request $request): Widget
    {
        $widget = $request->attributes->get('widget');

        abort_unless($widget instanceof Widget, 404);

        return $widget;
    }

    /**
     * A JSON response with a content ETag and the given Cache-Control; answers `304` when the client already has it.
     *
     * @param  array<string, mixed>  $body
     * @param  array<string, mixed>  $etagBody  The part of the body that identifies its version (volatile fields left out).
     */
    protected function cacheableJson(Request $request, array $body, array $etagBody, string $cacheControl): Response
    {
        $response = response()->json($body, 200, [], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $response->setEtag(substr(sha1((string) json_encode($etagBody)), 0, 32));
        $response->headers->set('Cache-Control', $cacheControl);
        $response->isNotModified($request);

        return $response;
    }
}
