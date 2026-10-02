<?php

namespace Tests\Support;

use App\Support\ApiDocs\ApiAudience;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Yaml\Yaml;

/**
 * A deliberately small contract check of a REAL response against the committed OpenAPI file (`docs/api/openapi-*.yaml`): the status is
 * documented for the operation, and the JSON body matches the schema the file gives it, resolving `$ref` / `allOf` / `oneOf`:
 * required keys present, no key the schema does not know, scalar types, `nullable`, `enum` and the `date-time` format. No validator
 * dependency: this is the 80% that catches a field added, removed or retyped without the reference being regenerated.
 *
 * The check also fails on a key the response carries that the schema lacks, so an undocumented field cannot slip into an answer.
 *
 * @mixin TestCase
 */
trait AssertsOpenApi
{
    /** @var array<string, array<string, mixed>> */
    private static array $openApiSpecs = [];

    /**
     * @param  string  $path  The path as the spec spells it: `/api/v1/conversations/{conversation}/messages`.
     */
    protected function assertMatchesOpenApi(TestResponse $response, ApiAudience $audience, string $method, string $path): void
    {
        $spec = $this->openApiSpec($audience);
        $operation = $spec['paths'][$path][strtolower($method)] ?? null;

        Assert::assertIsArray($operation, "The {$audience->value} OpenAPI file has no operation [{$method} {$path}].");

        $status = $response->getStatusCode();
        $documented = $operation['responses'][$status] ?? $operation['responses'][(string) $status] ?? null;

        Assert::assertIsArray($documented, "[{$method} {$path}] answered {$status}, which the OpenAPI file does not document (it documents ".implode(', ', array_keys($operation['responses'])).').');

        $content = (string) $response->getContent();

        if (in_array($status, [204, 304], true)) {
            Assert::assertSame('', $content, "[{$method} {$path}] {$status} must have no body.");

            return;
        }

        $schema = $documented['content']['application/json']['schema'] ?? null;

        if ($schema === null) {
            return;
        }

        $body = json_decode($content, false, 512, JSON_THROW_ON_ERROR);
        $problems = [];
        $this->validateSchema($spec, $schema, $body, '$', $problems);

        Assert::assertSame([], $problems, "[{$method} {$path}] {$status} does not match the OpenAPI schema:\n - ".implode("\n - ", $problems));
    }

    /**
     * @return array<string, mixed>
     */
    protected function openApiSpec(ApiAudience $audience): array
    {
        return self::$openApiSpecs[$audience->value] ??= Yaml::parseFile($audience->specPath());
    }

    /**
     * @param  array<string, mixed>  $spec
     * @param  array<string, mixed>  $schema
     * @param  list<string>  $problems
     */
    private function validateSchema(array $spec, array $schema, mixed $value, string $at, array &$problems): void
    {
        if (isset($schema['$ref'])) {
            $name = substr((string) $schema['$ref'], strlen('#/components/schemas/'));
            $this->validateSchema($spec, $spec['components']['schemas'][$name] ?? ['__missing' => $name], $value, $at, $problems);

            return;
        }

        if (isset($schema['__missing'])) {
            $problems[] = "{$at}: the schema {$schema['__missing']} does not exist";

            return;
        }

        if ($value === null) {
            if (($schema['nullable'] ?? false) !== true) {
                $problems[] = "{$at}: null, but the schema is not nullable";
            }

            return;
        }

        if (isset($schema['allOf'])) {
            foreach ($schema['allOf'] as $part) {
                $this->validateSchema($spec, $part, $value, $at, $problems);
            }

            return;
        }

        if (isset($schema['oneOf'])) {
            foreach ($schema['oneOf'] as $option) {
                $attempt = [];
                $this->validateSchema($spec, $option, $value, $at, $attempt);

                if ($attempt === []) {
                    return;
                }
            }

            $problems[] = "{$at}: matches none of the oneOf options";

            return;
        }

        $type = $schema['type'] ?? null;

        if (isset($schema['enum']) && ! in_array($value, $schema['enum'], true)) {
            $problems[] = "{$at}: [".json_encode($value).'] is not one of '.json_encode($schema['enum']);
        }

        switch ($type) {
            case 'object':
                if (! $value instanceof \stdClass) {
                    $problems[] = "{$at}: expected an object, got ".get_debug_type($value);

                    return;
                }

                $this->validateObject($spec, $schema, $value, $at, $problems);

                return;

            case 'array':
                if (! is_array($value)) {
                    $problems[] = "{$at}: expected an array, got ".get_debug_type($value);

                    return;
                }

                foreach ($value as $index => $item) {
                    $this->validateSchema($spec, $schema['items'] ?? [], $item, "{$at}[{$index}]", $problems);
                }

                return;

            case 'string':
                if (! is_string($value)) {
                    $problems[] = "{$at}: expected a string, got ".get_debug_type($value);
                } elseif (($schema['format'] ?? null) === 'date-time' && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/', $value) !== 1) {
                    $problems[] = "{$at}: [{$value}] is not an ISO-8601 UTC timestamp";
                }

                return;

            case 'integer':
                if (! is_int($value)) {
                    $problems[] = "{$at}: expected an integer, got ".get_debug_type($value);
                }

                return;

            case 'number':
                if (! is_int($value) && ! is_float($value)) {
                    $problems[] = "{$at}: expected a number, got ".get_debug_type($value);
                }

                return;

            case 'boolean':
                if (! is_bool($value)) {
                    $problems[] = "{$at}: expected a boolean, got ".get_debug_type($value);
                }

                return;

            default:
                return;
        }
    }

    /**
     * @param  array<string, mixed>  $spec
     * @param  array<string, mixed>  $schema
     * @param  list<string>  $problems
     */
    private function validateObject(array $spec, array $schema, \stdClass $value, string $at, array &$problems): void
    {
        $properties = $schema['properties'] ?? [];
        $present = array_keys(get_object_vars($value));

        foreach ($schema['required'] ?? [] as $required) {
            if (! in_array($required, $present, true)) {
                $problems[] = "{$at}: the required key [{$required}] is missing";
            }
        }

        foreach ($present as $key) {
            if (isset($properties[$key])) {
                $this->validateSchema($spec, $properties[$key], $value->{$key}, "{$at}.{$key}", $problems);
            } elseif (isset($schema['additionalProperties'])) {
                if (is_array($schema['additionalProperties'])) {
                    $this->validateSchema($spec, $schema['additionalProperties'], $value->{$key}, "{$at}.{$key}", $problems);
                }
            } elseif ($properties !== []) {
                // An object schema without properties is free-form (`details`, `meta`): only a described object rejects strangers.
                $problems[] = "{$at}: the key [{$key}] is not in the schema";
            }
        }
    }
}
