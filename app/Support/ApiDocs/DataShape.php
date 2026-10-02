<?php

namespace App\Support\ApiDocs;

/**
 * The response example and the field table of a spatie `Data` class, built from the class itself ({@see DataProperties}) with
 * realistic values from {@see ExampleValues}, so the JSON shown can never drift from the class a controller returns. Only the prose
 * ({@see FieldDocs}) is written by hand.
 *
 * Field paths follow Scribe's convention (dots, no list indexes): `data.attachments.url`.
 *
 * @phpstan-type FieldSpec array{path: string, type: string, description: string, required: bool, nullable: bool, enum: list<string|int>}
 */
final class DataShape
{
    /**
     * @param  class-string  $class
     * @param  string  $prefix  The path of the object the class describes (`data`, or empty for the root).
     * @param  bool  $withOptional  Whether `Optional` properties appear in the example (staff payloads) or not (visitor payloads).
     * @return array{example: array<string, mixed>, fields: array<string, FieldSpec>}
     */
    public function describe(string $class, string $prefix = '', bool $withOptional = true): array
    {
        $fields = [];
        $example = $this->walk($class, $prefix, $withOptional, $fields);

        return ['example' => $example, 'fields' => $fields];
    }

    /**
     * @param  class-string  $class
     * @param  array<string, FieldSpec>  $fields
     * @return array<string, mixed>
     */
    private function walk(string $class, string $prefix, bool $withOptional, array &$fields): array
    {
        $example = [];

        foreach (DataProperties::of($class) as $property) {
            if ($property['optional'] && ! $withOptional) {
                continue;
            }

            $name = $property['name'];
            $path = $prefix === '' ? $name : $prefix.'.'.$name;
            $spec = ['path' => $path, 'type' => 'string', 'description' => $property['description'], 'required' => ! $property['optional'], 'nullable' => $property['nullable'], 'enum' => []];

            switch ($property['kind']) {
                case 'data':
                    $spec['type'] = 'object';
                    $fields[$path] = $spec;
                    $example[$name] = $property['class'] === null ? [] : $this->walk($property['class'], $path, $withOptional, $fields);

                    break;

                case 'list':
                    $example[$name] = $this->listExample($property, $path, $withOptional, $fields, $spec);

                    break;

                case 'map':
                    $spec['type'] = 'object';
                    $fields[$path] = $spec;
                    $example[$name] = ExampleValues::map($class, $name, $property['documented']);

                    break;

                case 'enum':
                    $values = $property['values'];
                    $spec['enum'] = $values;
                    $spec['type'] = $property['type'] === 'int' ? 'integer' : 'string';
                    $pinned = ExampleValues::for($class, $name, 'string');
                    $example[$name] = in_array($pinned, $values, true) ? $pinned : ($values[0] ?? 'example');
                    $fields[$path] = $spec;

                    break;

                default:
                    $spec['type'] = match ($property['type']) {
                        'int' => 'integer',
                        'float' => 'number',
                        'bool' => 'boolean',
                        default => 'string',
                    };
                    $example[$name] = ExampleValues::for($class, $name, $property['type']);
                    $fields[$path] = $spec;
            }
        }

        return $example;
    }

    /**
     * @param  array{name: string, class: class-string|null, item: string|null}  $property
     * @param  array<string, FieldSpec>  $fields
     * @param  FieldSpec  $spec
     * @return list<mixed>
     */
    private function listExample(array $property, string $path, bool $withOptional, array &$fields, array $spec): array
    {
        if ($property['class'] !== null) {
            $spec['type'] = 'object[]';
            $fields[$path] = $spec;

            return [$this->walk($property['class'], $path, $withOptional, $fields)];
        }

        $scalar = match ($property['item']) {
            'int' => 'integer',
            'bool' => 'boolean',
            default => 'string',
        };
        $spec['type'] = $scalar.'[]';
        $fields[$path] = $spec;

        return [match ($scalar) {
            'integer' => 1,
            'boolean' => true,
            default => match (true) {
                str_contains($property['name'], 'ulid') => ExampleValues::ulid('category'),
                $property['name'] === 'methods' => 'totp',
                default => 'example',
            },
        }];
    }
}
