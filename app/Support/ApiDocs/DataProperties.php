<?php

namespace App\Support\ApiDocs;

use BackedEnum;
use ReflectionClass;
use ReflectionMethod;
use ReflectionNamedType;
use ReflectionProperty;
use ReflectionType;
use ReflectionUnionType;
use Spatie\LaravelData\Attributes\DataCollectionOf;
use Spatie\LaravelData\Attributes\WithTransformer;
use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;

/**
 * Reads the serialised shape of a spatie `Data` class from the class itself: the typed constructor gives every property its type,
 * nullability and nesting; `#[DataCollectionOf]` and the `@param array<int, X>` annotation give list items; `int|Optional` marks a
 * property that is absent from some payloads; a backed enum gives its values. One reader feeds both the response examples
 * ({@see DataShape}) and the OpenAPI component schemas ({@see DataSchema}), so they cannot disagree.
 *
 * `kind` is one of `scalar` (`type` = `string`/`int`/`float`/`bool`), `enum`, `data` (a nested Data class), `list` (of `item`) or `map`
 * (a string-keyed JSON object).
 *
 * @phpstan-type Property array{name: string, kind: string, type: string, class: class-string|null, item: string|null, values: list<string|int>, nullable: bool, optional: bool, description: string, documented: string|null}
 */
final class DataProperties
{
    /**
     * @param  class-string  $class
     * @return list<Property>
     */
    public static function of(string $class): array
    {
        $constructor = (new ReflectionClass($class))->getConstructor();

        if ($constructor === null) {
            return [];
        }

        $documented = self::documentedTypes($constructor);
        $properties = [];

        foreach ($constructor->getParameters() as $parameter) {
            $name = $parameter->getName();
            ['types' => $types, 'nullable' => $nullable, 'optional' => $optional] = self::decompose($parameter->getType());
            $type = $types[0] ?? 'string';
            $property = ['name' => $name, 'kind' => 'scalar', 'type' => $type, 'class' => null, 'item' => null, 'values' => [], 'nullable' => $nullable, 'optional' => $optional, 'description' => FieldDocs::describe($class, $name), 'documented' => $documented[$name] ?? null];

            if ($type === 'array') {
                $property = self::collection($class, $name, $property);
            } elseif (enum_exists($type) && is_subclass_of($type, BackedEnum::class)) {
                $values = array_map(static fn (BackedEnum $case): string|int => $case->value, $type::cases());
                $property['kind'] = 'enum';
                $property['class'] = $type;
                $property['values'] = $values;
                $property['type'] = is_int($values[0] ?? null) ? 'int' : 'string';
            } elseif (class_exists($type) && is_subclass_of($type, Data::class)) {
                $property['kind'] = 'data';
                $property['class'] = $type;
            }

            $properties[] = $property;
        }

        return $properties;
    }

    /**
     * A list of Data objects or scalars, or a string-keyed map (a JSON object), judged from the attribute or the annotation.
     *
     * @param  class-string  $owner
     * @param  Property  $property
     * @return Property
     */
    private static function collection(string $owner, string $name, array $property): array
    {
        $reflection = new ReflectionProperty($owner, $name);
        $documented = $property['documented'];
        $isMap = $reflection->getAttributes(WithTransformer::class) !== [] || ($documented !== null && preg_match('/^array<\s*string\s*,/i', $documented) === 1);

        $item = null;
        $attribute = $reflection->getAttributes(DataCollectionOf::class)[0] ?? null;

        if ($attribute !== null) {
            /** @var DataCollectionOf $instance */
            $instance = $attribute->newInstance();
            $item = $instance->class;
        } elseif ($documented !== null) {
            $item = self::itemType($documented, $owner);
        }

        $itemIsData = $item !== null && class_exists($item) && is_subclass_of($item, Data::class);

        if ($isMap && ! $itemIsData) {
            $property['kind'] = 'map';
            $property['item'] = $item;

            return $property;
        }

        $property['kind'] = 'list';
        $property['item'] = $item ?? 'string';

        if ($itemIsData) {
            $property['class'] = $item;
        }

        return $property;
    }

    /**
     * The non-null, non-`Optional` types of a parameter.
     *
     * @return array{types: list<string>, nullable: bool, optional: bool}
     */
    private static function decompose(?ReflectionType $type): array
    {
        $members = match (true) {
            $type instanceof ReflectionUnionType => $type->getTypes(),
            $type instanceof ReflectionNamedType => [$type],
            default => [],
        };
        $types = [];
        $nullable = $type?->allowsNull() ?? false;
        $optional = false;

        foreach ($members as $member) {
            if (! $member instanceof ReflectionNamedType) {
                continue;
            }

            $name = $member->getName();

            if ($name === 'null') {
                $nullable = true;
            } elseif ($name === Optional::class) {
                $optional = true;
            } else {
                $types[] = $name;
            }
        }

        return ['types' => $types, 'nullable' => $nullable, 'optional' => $optional];
    }

    /**
     * The `@param` types of the constructor's docblock, by parameter name. The type runs to the first whitespace outside brackets.
     *
     * @return array<string, string>
     */
    private static function documentedTypes(ReflectionMethod $constructor): array
    {
        $doc = $constructor->getDocComment();

        if ($doc === false) {
            return [];
        }

        $types = [];
        $offset = 0;
        $length = strlen($doc);

        while (($at = strpos($doc, '@param', $offset)) !== false) {
            $offset = $at + 6;
            $cursor = $offset;

            while ($cursor < $length && ctype_space($doc[$cursor])) {
                $cursor++;
            }

            $start = $cursor;
            $depth = 0;

            for (; $cursor < $length; $cursor++) {
                $char = $doc[$cursor];
                $depth += $char === '<' ? 1 : ($char === '>' ? -1 : 0);

                if ($depth === 0 && ctype_space($char)) {
                    break;
                }
            }

            $type = trim(substr($doc, $start, $cursor - $start));

            if ($type !== '' && preg_match('/\s*\$(\w+)/', substr($doc, $cursor, 80), $name) === 1) {
                $types[$name[1]] = $type;
            }
        }

        return $types;
    }

    /**
     * The class (or scalar name) a documented list type holds: `array<int, AttachmentData>`, `list<X>`, `X[]`.
     *
     * @param  class-string  $owner
     */
    private static function itemType(string $documented, string $owner): ?string
    {
        if (preg_match('/^(?:array|list)<\s*(?:[\w|]+\s*,\s*)?([\\\\\w]+)\s*(?:\|null)?\s*>$/', $documented, $matches) === 1) {
            $item = $matches[1];
        } elseif (preg_match('/^([\\\\\w]+)\[\]$/', $documented, $matches) === 1) {
            $item = $matches[1];
        } else {
            return null;
        }

        if (in_array($item, ['int', 'string', 'bool', 'float', 'scalar', 'mixed'], true)) {
            return $item;
        }

        return self::resolveClass($item, $owner);
    }

    /**
     * @param  class-string  $owner
     */
    private static function resolveClass(string $short, string $owner): ?string
    {
        if (str_contains($short, '\\')) {
            return ltrim($short, '\\');
        }

        $reflection = new ReflectionClass($owner);
        $source = $reflection->getFileName() !== false ? (string) file_get_contents($reflection->getFileName()) : '';

        if (preg_match('/^use\s+([\\\\\w]+\\\\'.preg_quote($short, '/').')\s*;/m', $source, $matches) === 1) {
            return $matches[1];
        }

        $candidate = $reflection->getNamespaceName().'\\'.$short;

        return class_exists($candidate) ? $candidate : null;
    }
}
