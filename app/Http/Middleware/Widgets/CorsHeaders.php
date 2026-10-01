<?php

namespace App\Http\Middleware\Widgets;

use Symfony\Component\HttpFoundation\Response;

/**
 * The CORS headers of an allowed browser origin on the public widget API. One place, so a `200`, a `304` and a `429`
 * all look the same to the visitor's browser (a response without them is opaque to the page's JavaScript).
 */
final class CorsHeaders
{
    public static function allow(Response $response, ?string $origin): Response
    {
        $response->headers->set('Vary', 'Origin');

        if ($origin !== null) {
            $response->headers->set('Access-Control-Allow-Origin', $origin);

            if ($response->getStatusCode() === 429) {
                // `Retry-After` is not a safelisted response header: without this the page could not read it.
                $response->headers->set('Access-Control-Expose-Headers', 'Retry-After');
            }
        }

        return $response;
    }
}
