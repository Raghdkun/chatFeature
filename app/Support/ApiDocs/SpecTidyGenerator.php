<?php

namespace App\Support\ApiDocs;

use Illuminate\Support\Str;
use Knuckles\Camel\Output\OutputEndpointData;
use Knuckles\Scribe\Writing\OpenApiSpecGenerators\OpenApiGenerator;

/**
 * Corrections to what Scribe writes into the OpenAPI file, so it stays small enough to review and its operation ids are stable:
 *
 *  - `operationId` is derived from the route NAME (`api.conversations.messages.index` -> `conversationsMessagesIndex`), which is
 *    unique and does not change when a title is reworded (Scribe camel-cases the title, and two titles can collide);
 *  - every success payload that is a Data class becomes a reference to its component schema (`components.schemas.ConversationStaff`,
 *    built by {@see DataSchema}) wrapped in the `{ data }` / `{ data, meta }` envelope, instead of an inline copy per operation;
 *  - every error answer (status 400 and up) becomes a reference to a shared schema of the error envelope, one per error code
 *    (`components.schemas.ErrorAlreadyClaimed`), instead of an inline copy per operation; a status with several possible codes is
 *    a `oneOf` of references and its description names each code and when it happens;
 *  - responses that have no body (`204`, `304`) carry no `content`, and a parameter does not repeat its description and example inside
 *    its schema.
 */
class SpecTidyGenerator extends OpenApiGenerator
{
    /** @var array<string, string>|null */
    private static ?array $names = null;

    /**
     * @param  array<string, mixed>  $root
     * @param  array<int, array{description: string, name: string, endpoints: OutputEndpointData[]}>  $groupedEndpoints
     * @return array<string, mixed>
     */
    public function root(array $root, array $groupedEndpoints): array
    {
        $codes = [];

        foreach ($groupedEndpoints as $group) {
            foreach ($group['endpoints'] as $endpoint) {
                foreach ($endpoint->responses as $response) {
                    $code = $this->errorCode($response->status, $response->content);

                    if ($code !== null) {
                        $codes[$code] = true;
                    }
                }
            }
        }

        ksort($codes);

        $schemas = $this->dataSchemas($groupedEndpoints) + ['ErrorEnvelope' => [
            'type' => 'object',
            'description' => 'The body of every error answer: a machine-readable `code`, a human `message` and, for some codes, structured `details`.',
            'required' => ['error'],
            'properties' => ['error' => [
                'type' => 'object',
                'required' => ['code', 'message'],
                'properties' => [
                    'code' => ['type' => 'string', 'description' => 'Branch on this, never on `message`.'],
                    'message' => ['type' => 'string'],
                    'details' => ['type' => 'object', 'description' => 'Keyed by field for `validation_failed`; structured values elsewhere.'],
                ],
            ]],
        ]];

        foreach (array_keys($codes) as $code) {
            $spec = ErrorCatalogue::get($code);
            $error = [
                'type' => 'object',
                'required' => ['code', 'message'],
                'properties' => [
                    'code' => ['type' => 'string', 'enum' => [$code]],
                    'message' => ['type' => 'string', 'example' => $spec['message']],
                ],
            ];

            if (isset($spec['details'])) {
                $error['properties']['details'] = ['type' => 'object', 'example' => $spec['details']];
            }

            $schemas[self::schemaName($code)] = [
                'type' => 'object',
                'description' => $spec['meaning'],
                'required' => ['error'],
                'properties' => ['error' => $error],
                'example' => ErrorCatalogue::body($code),
            ];
        }

        $root['components']['schemas'] = ($root['components']['schemas'] ?? []) + $schemas;

        return $root;
    }

    /**
     * @param  array<string, mixed>  $pathItem
     * @param  array<int, array{description: string, name: string, endpoints: OutputEndpointData[]}>  $groupedEndpoints
     * @return array<string, mixed>
     */
    public function pathItem(array $pathItem, array $groupedEndpoints, OutputEndpointData $endpoint): array
    {
        $name = self::routeNames()[strtoupper($endpoint->httpMethods[0]).' /'.ltrim($endpoint->uri, '/')] ?? null;

        if ($name !== null) {
            $pathItem['operationId'] = Str::camel(str_replace(['api.', '.'], ['', '_'], $name));
        }

        $pathItem = $this->withDataReferences($pathItem, $name);

        if (($pathItem['parameters'] ?? null) === []) {
            unset($pathItem['parameters']);
        }

        // Scribe repeats a parameter's description and example inside its schema.
        foreach ($pathItem['parameters'] ?? [] as $index => $parameter) {
            if (isset($parameter['schema']) && is_array($parameter['schema'])) {
                unset($pathItem['parameters'][$index]['schema']['description'], $pathItem['parameters'][$index]['schema']['example']);
            }
        }

        foreach (['204', '304'] as $status) {
            unset($pathItem['responses'][$status]['content']);

            if (isset($pathItem['responses'][$status]) && ($pathItem['responses'][$status]['description'] ?? '') === '') {
                $pathItem['responses'][$status]['description'] = $status === '204' ? 'No content.' : 'Not modified.';
            }
        }

        return $this->withErrorReferences($pathItem, $endpoint);
    }

    /**
     * The component schema of every Data class an endpoint of this reference returns.
     *
     * @param  array<int, array{description: string, name: string, endpoints: OutputEndpointData[]}>  $groupedEndpoints
     * @return array<string, array<string, mixed>>
     */
    private function dataSchemas(array $groupedEndpoints): array
    {
        $schemas = new DataSchema;
        $components = [];
        $names = self::routeNames();

        foreach ($groupedEndpoints as $group) {
            foreach ($group['endpoints'] as $endpoint) {
                $doc = Catalogue::all()[$names[strtoupper($endpoint->httpMethods[0]).' /'.ltrim($endpoint->uri, '/')] ?? ''] ?? null;

                foreach ($doc->successes ?? [] as $success) {
                    if ($success->class !== null) {
                        $components += $schemas->components($success->class);
                    }
                }
            }
        }

        ksort($components);

        return $components;
    }

    /**
     * @param  array<string, mixed>  $pathItem
     * @return array<string, mixed>
     */
    private function withDataReferences(array $pathItem, ?string $routeName): array
    {
        $doc = $routeName === null ? null : (Catalogue::all()[$routeName] ?? null);

        foreach ($doc->successes ?? [] as $success) {
            if ($success->class === null) {
                continue;
            }

            $reference = ['$ref' => '#/components/schemas/'.DataSchema::name($success->class)];
            $data = match (true) {
                $success->kind === 'item' && $success->nullable => ['allOf' => [$reference], 'nullable' => true],
                $success->kind === 'item' => $reference,
                default => ['type' => 'array', 'items' => $reference],
            };
            $properties = ['data' => $data];

            if ($success->kind !== 'item') {
                $meta = ['next_cursor' => ['type' => 'string', 'nullable' => true, 'description' => $success->kind === 'paged' ? 'Opaque cursor of the next page: pass it as `cursor`. `null` on the last page.' : 'Always `null`: this list is complete.']];

                foreach ((array) $success->example as $key => $value) {
                    $meta[$key] = ['type' => is_int($value) ? 'integer' : 'string', 'nullable' => $value === null];
                }

                $properties['meta'] = ['type' => 'object', 'required' => array_keys($meta), 'properties' => $meta];
            }

            $pathItem['responses'][$success->status]['content'] = ['application/json' => ['schema' => ['type' => 'object', 'required' => array_keys($properties), 'properties' => $properties]]];
        }

        return $pathItem;
    }

    /**
     * @param  array<string, mixed>  $pathItem
     * @return array<string, mixed>
     */
    private function withErrorReferences(array $pathItem, OutputEndpointData $endpoint): array
    {
        /** @var array<int, list<array{code: string, when: string}>> $byStatus */
        $byStatus = [];

        foreach ($endpoint->responses as $response) {
            $code = $this->errorCode($response->status, $response->content);

            if ($code === null) {
                continue;
            }

            $when = (string) preg_replace('/^`[^`]+`:\s*/', '', (string) $response->description);
            // The general meaning lives on the component schema: an operation only says what is specific to it.
            $byStatus[$response->status][] = ['code' => $code, 'when' => $when === ErrorCatalogue::get($code)['meaning'] ? '' : $when];
        }

        foreach ($byStatus as $status => $errors) {
            $references = array_map(static fn (array $error): array => ['$ref' => '#/components/schemas/'.self::schemaName($error['code'])], $errors);
            $line = static fn (array $error): string => '`'.$error['code'].'`'.($error['when'] === '' ? '' : ': '.$error['when']);
            $description = count($errors) === 1 ? $line($errors[0]) : implode("\n", array_map(static fn (array $error): string => '- '.$line($error), $errors));

            $retryAfter = array_filter($errors, static fn (array $error): bool => isset(ErrorCatalogue::get($error['code'])['headers']['Retry-After']));
            $response = [
                'description' => $description,
                'content' => ['application/json' => ['schema' => count($references) === 1 ? $references[0] : ['oneOf' => $references]]],
            ];

            if (count($retryAfter) === count($errors)) {
                $response['headers'] = ['Retry-After' => ['description' => 'Seconds to wait before trying again.', 'schema' => ['type' => 'integer']]];
            }

            $pathItem['responses'][$status] = $response;
        }

        return $pathItem;
    }

    private function errorCode(int $status, ?string $content): ?string
    {
        if ($status < 400 || $content === null) {
            return null;
        }

        $decoded = json_decode($content, true);
        $code = is_array($decoded) && is_array($decoded['error'] ?? null) ? ($decoded['error']['code'] ?? null) : null;

        return is_string($code) ? $code : null;
    }

    /** `already_claimed` => `ErrorAlreadyClaimed` */
    public static function schemaName(string $code): string
    {
        return 'Error'.Str::studly($code);
    }

    /**
     * @return array<string, string> `GET /api/v1/x/{id}` => route name
     */
    private static function routeNames(): array
    {
        if (self::$names !== null) {
            return self::$names;
        }

        $names = [];

        foreach ([ApiAudience::Management, ApiAudience::Public] as $audience) {
            foreach (ApiRoutes::forAudience($audience) as $route) {
                if ($route->getName() !== null) {
                    $names[ApiRoutes::label($route)] = $route->getName();
                }
            }
        }

        return self::$names = $names;
    }
}
