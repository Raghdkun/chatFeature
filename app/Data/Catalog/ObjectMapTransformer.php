<?php

namespace App\Data\Catalog;

use Spatie\LaravelData\Support\DataProperty;
use Spatie\LaravelData\Support\Transformation\TransformationContext;
use Spatie\LaravelData\Transformers\Transformer;

/**
 * Serialises a string-keyed map as a JSON object even when it is empty (`{}`, not `[]`), matching its TypeScript type
 * `Record<string, string>`.
 */
final class ObjectMapTransformer implements Transformer
{
    public function transform(DataProperty $property, mixed $value, TransformationContext $context): mixed
    {
        return is_array($value) ? (object) $value : $value;
    }
}
