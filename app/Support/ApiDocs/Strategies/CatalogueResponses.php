<?php

namespace App\Support\ApiDocs\Strategies;

use App\Http\Middleware\Widgets\AuthorizeWidgetOrigin;
use App\Support\ApiDocs\ApiRoutes;
use App\Support\ApiDocs\Catalogue;
use App\Support\ApiDocs\DataSchema;
use App\Support\ApiDocs\DataShape;
use App\Support\ApiDocs\Doc;
use App\Support\ApiDocs\ErrorCatalogue;
use App\Support\ApiDocs\Success;
use Illuminate\Routing\Route;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\Strategy;
use RuntimeException;
use Spatie\LaravelData\Data;

/**
 * The response examples of an endpoint:
 *
 *  - its successes from the catalogue entry; a Data class is turned into the example by {@see DataShape}, so the JSON shown is
 *    built from the class the controller returns;
 *  - the errors its route can answer with, DERIVED from the middleware (authentication, session validity, chat access, admin,
 *    visitor token, widget origin gate, signature, rate limits, validation, 404 for ids) plus the codes the entry declares.
 */
class CatalogueResponses extends Strategy
{
    /**
     * @param  array<string, mixed>  $settings
     * @return list<array<string, mixed>>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $settings = []): array
    {
        $route = $endpointData->route ?? throw new RuntimeException('Endpoint without a route.');
        $doc = Catalogue::for($route) ?? throw new RuntimeException('No API reference entry for route ['.($route->getName() ?? ApiRoutes::label($route)).'].');

        $responses = [];

        foreach ($doc->successes as $success) {
            $responses[] = $this->success($success);
        }

        $hasInput = $endpointData->bodyParameters !== [] || $endpointData->queryParameters !== [];

        foreach ($this->errorCodes($route, $doc, $hasInput) as $code => $when) {
            $responses[] = $this->error($code, $when);
        }

        return $responses;
    }

    /**
     * @return array<string, mixed>
     */
    private function success(Success $success): array
    {
        $shape = new DataShape;
        $description = $success->note;
        $headers = $success->headers;

        $content = match ($success->kind) {
            'item' => ['data' => $shape->describe($this->dataClass($success), 'data', $success->staff)['example']],
            'list' => ['data' => [$shape->describe($this->dataClass($success), 'data', $success->staff)['example']], 'meta' => ['next_cursor' => null]],
            'paged' => ['data' => [$shape->describe($this->dataClass($success), 'data', $success->staff)['example']], 'meta' => ['next_cursor' => 'eyJjb252ZXJzYXRpb25zLmlkIjo0MiwiX3BvaW50c1RvTmV4dEl0ZW1zIjp0cnVlfQ'] + (array) $success->example],
            'data' => ['data' => $success->example],
            'plain' => $success->example,
            'none' => null,
            'raw' => $success->example,
            default => throw new RuntimeException("Unknown success kind [{$success->kind}]."),
        };

        if ($success->class !== null && $description === '') {
            $description = DataSchema::summary($success->class);
        }

        $response = [
            'status' => $success->status,
            'description' => $description,
            'content' => is_array($content) ? json_encode($content, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : $content,
        ];

        if ($headers !== []) {
            $response['headers'] = $headers;
        }

        return $response;
    }

    /**
     * @return array<string, mixed>
     */
    private function error(string $code, ?string $when): array
    {
        $spec = ErrorCatalogue::get($code);

        return [
            'status' => $spec['status'],
            'description' => '`'.$code.'`: '.($when ?? $spec['meaning']),
            'content' => json_encode(ErrorCatalogue::body($code), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'headers' => ($spec['headers'] ?? []) + ['Content-Type' => 'application/json'],
        ];
    }

    /**
     * The error codes of a route: derived from its middleware, then the entry's own.
     *
     * @return array<string, string|null> code => what makes this endpoint answer it (`null`: the general meaning)
     */
    private function errorCodes(Route $route, Doc $doc, bool $hasInput): array
    {
        $codes = [];
        $has = static fn (string $middleware): bool => ApiRoutes::hasMiddleware($route, $middleware);

        if ($has('auth')) {
            $codes['unauthenticated'] = null;
        }

        if ($has('session.valid')) {
            $codes['session_revoked'] = null;
            $codes['auth_unavailable'] = null;
        }

        if ($has('chat.access')) {
            $codes['no_chat_access'] = null;
        }

        if (ApiRoutes::isAdminOnly($route)) {
            $codes['forbidden'] = 'Not an active administrator.';
        }

        if (ApiRoutes::isVisitorRoute($route)) {
            $codes['unauthenticated'] = 'No or an unknown visitor token.';
            $codes['session_revoked'] = null;
            $codes['widget_not_found'] = null;
        }

        if ($has(AuthorizeWidgetOrigin::class)) {
            $codes['widget_not_found'] = null;
            $codes['origin_not_allowed'] = null;
        }

        if ($has('signed')) {
            $codes['forbidden'] = 'The signature is missing, altered, expired or belongs to another URL.';
        }

        if ($hasInput) {
            $codes['validation_failed'] = null;
        }

        if (array_filter(ApiRoutes::parameters($route), static fn (string $name): bool => $name !== 'key') !== [] && ! $has('signed')) {
            $codes['not_found'] = ApiRoutes::isVisitorRoute($route)
                ? 'The id is not one of this visitor token\'s conversations (another visitor\'s is `404`, never `403`).'
                : 'Unknown id.';
        }

        if (ApiRoutes::limiters($route) !== [] || $has('signed')) {
            $codes['rate_limited'] = null;
        }

        foreach ($doc->errors as $code => $when) {
            $codes[$code] = $when;
        }

        return $codes;
    }

    /**
     * @return class-string<Data>
     */
    private function dataClass(Success $success): string
    {
        return $success->class ?? throw new RuntimeException('A success of kind ['.$success->kind.'] needs a Data class.');
    }
}
