<?php

namespace App\Support\ApiDocs;

use LogicException;
use ReflectionClass;

/**
 * OpenAPI component schemas of spatie `Data` classes, built from the classes themselves ({@see DataProperties}): every Data class
 * the reference mentions becomes one named schema (`ConversationStaffData` -> `ConversationStaff`) that nested classes reference with
 * `$ref`, so a payload is described once however many endpoints return it. Types, nullability, enum values, `required` (everything
 * except `Optional` properties) and nesting come from the code; descriptions from {@see FieldDocs}.
 */
final class DataSchema
{
    /** @var array<string, class-string> schema name => class, to refuse two classes with one name */
    private array $names = [];

    /** `ConversationStaffData` => `ConversationStaff` */
    public static function name(string $class): string
    {
        $short = ExampleValues::short($class);

        return str_ends_with($short, 'Data') && strlen($short) > 4 ? substr($short, 0, -4) : $short;
    }

    /**
     * The schema of a class and of every Data class nested in it.
     *
     * @param  class-string  $class
     * @return array<string, array<string, mixed>>
     */
    public function components(string $class): array
    {
        $components = [];
        $this->collect($class, $components);

        return $components;
    }

    /**
     * The first sentence of a class's docblock: what the payload is.
     *
     * @param  class-string  $class
     */
    public static function summary(string $class): string
    {
        $doc = (new ReflectionClass($class))->getDocComment();

        if ($doc === false) {
            return '';
        }

        $text = preg_replace('/^\s*(?:\/\*\*|\*\/|\*)\s?/m', '', $doc) ?? '';
        $text = trim(explode("\n\n", trim($text))[0]);
        $text = preg_replace('/\s+/', ' ', $text) ?? $text;

        return preg_replace('/^(.+?[.!?])(\s.*)?$/s', '$1', $text) ?? $text;
    }

    /**
     * @param  class-string  $class
     * @param  array<string, array<string, mixed>>  $components
     */
    private function collect(string $class, array &$components): void
    {
        $name = self::name($class);

        if (isset($this->names[$name]) && $this->names[$name] !== $class) {
            throw new LogicException("Two Data classes map to the schema name [{$name}]: {$this->names[$name]} and {$class}.");
        }

        if (isset($components[$name])) {
            return;
        }

        $this->names[$name] = $class;
        $components[$name] = [];
        $properties = [];
        $required = [];

        foreach (DataProperties::of($class) as $property) {
            $properties[$property['name']] = $this->property($property, $components);

            if (! $property['optional']) {
                $required[] = $property['name'];
            }
        }

        $schema = ['type' => 'object'];
        $summary = self::summary($class);

        if ($summary !== '') {
            $schema['description'] = $summary;
        }

        if ($required !== []) {
            $schema['required'] = $required;
        }

        $schema['properties'] = $properties;
        $schema['example'] = (new DataShape)->describe($class)['example'];
        $components[$name] = $schema;
    }

    /**
     * @param  array{name: string, kind: string, type: string, class: class-string|null, item: string|null, values: list<string|int>, nullable: bool, optional: bool, description: string, documented: string|null}  $property
     * @param  array<string, array<string, mixed>>  $components
     * @return array<string, mixed>
     */
    private function property(array $property, array &$components): array
    {
        $schema = match ($property['kind']) {
            'data' => $property['class'] === null ? ['type' => 'object'] : $this->reference($property['class'], $components),
            'list' => ['type' => 'array', 'items' => $property['class'] !== null ? $this->reference($property['class'], $components) : $this->scalar((string) $property['item'], $property['name'])],
            'map' => ['type' => 'object', 'additionalProperties' => in_array($property['item'], ['string', 'int', 'bool', 'float'], true) ? $this->scalar((string) $property['item'], $property['name']) : true],
            'enum' => ['type' => $property['type'] === 'int' ? 'integer' : 'string', 'enum' => $property['values']],
            default => $this->scalar($property['type'], $property['name']),
        };

        if ($property['description'] !== '') {
            $schema['description'] = $property['description'];
        }

        if ($property['nullable']) {
            $schema['nullable'] = true;
        }

        // `$ref` takes no siblings in OpenAPI 3.0: a described or nullable reference is wrapped.
        if (isset($schema['$ref']) && count($schema) > 1) {
            $reference = ['$ref' => $schema['$ref']];
            unset($schema['$ref']);
            $schema = ['allOf' => [$reference]] + $schema;
        }

        return $schema;
    }

    /**
     * @param  class-string  $class
     * @param  array<string, array<string, mixed>>  $components
     * @return array<string, string>
     */
    private function reference(string $class, array &$components): array
    {
        $this->collect($class, $components);

        return ['$ref' => '#/components/schemas/'.self::name($class)];
    }

    /**
     * @return array<string, string>
     */
    private function scalar(string $type, string $name): array
    {
        return match ($type) {
            'int' => ['type' => 'integer'],
            'float' => ['type' => 'number'],
            'bool' => ['type' => 'boolean'],
            default => preg_match('/(?:At|Until|_at)$/', $name) === 1 || $name === 'waTimestamp' ? ['type' => 'string', 'format' => 'date-time'] : ['type' => 'string'],
        };
    }
}
