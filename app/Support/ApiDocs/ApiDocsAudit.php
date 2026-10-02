<?php

namespace App\Support\ApiDocs;

/**
 * Whether the reference covers the routes: every route under `api/v1` and `webhooks` (and the delivery routes of the public
 * reference) has exactly one catalogue entry, no entry points at a route that is gone, and everything an entry names exists (error
 * codes, rate limiters). Used by `docs:api` (it refuses to build an incomplete reference) and by the rot-guard test.
 */
final class ApiDocsAudit
{
    /**
     * @return list<string> what is wrong, one sentence each; empty when the reference is complete
     */
    public static function problems(): array
    {
        $problems = [];
        $docs = Catalogue::all();
        $seen = [];

        $routes = [...ApiRoutes::required(), ...array_filter(
            [...ApiRoutes::forAudience(ApiAudience::Public)],
            static fn ($route): bool => in_array($route->getName(), ApiAudience::DELIVERY_ROUTES, true),
        )];

        foreach ($routes as $route) {
            $name = $route->getName();
            $label = ApiRoutes::label($route);

            if (isset(Catalogue::undocumented()[$name ?? $label])) {
                continue;
            }

            if ($name === null) {
                $problems[] = "Route [{$label}] has no name, so it cannot have a reference entry: name it (or list it in Catalogue::undocumented()).";

                continue;
            }

            $seen[$name] = true;

            if (! isset($docs[$name])) {
                $problems[] = "Route [{$label}] ({$name}) has no reference entry: add one to App\\Support\\ApiDocs\\Entries (or list it in Catalogue::undocumented() with a reason).";
            }

            foreach (ApiRoutes::limiters($route) as $limiter) {
                if (RateLimitDocs::describe($limiter) === null) {
                    $problems[] = "Route [{$label}] uses the rate limiter [{$limiter}], which RateLimitDocs does not describe.";
                }
            }
        }

        foreach ($docs as $name => $doc) {
            if (! isset($seen[$name])) {
                $problems[] = "Reference entry [{$name}] has no route (renamed or removed?).";
            }

            foreach (array_keys($doc->errors) as $code) {
                if (! array_key_exists($code, ErrorCatalogue::all())) {
                    $problems[] = "Entry [{$name}] names the unknown error code [{$code}]: add it to ErrorCatalogue.";
                }
            }

            if ($doc->group === '' || $doc->title === '' || $doc->successes === []) {
                $problems[] = "Entry [{$name}] needs a group, a title and at least one success answer.";
            }
        }

        return $problems;
    }
}
