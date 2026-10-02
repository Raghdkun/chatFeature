<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\RequestDocs;

/**
 * Scribe folds `list.*` rules into their parent and keeps the child's (empty) description, so the prose written for the parent would be
 * lost. After the normalisation the descriptions, examples and (for free-form maps) types of {@see RequestDocs}
 * are applied to the parameters that really exist.
 */
final class ApplyRequestDocs
{
    /**
     * @param  array<string, array<string, mixed>>  $parameters
     * @param  array<string, array{description: string, example?: mixed, type?: string}>  $docs
     * @return array<string, array<string, mixed>>
     */
    public static function to(array $parameters, array $docs): array
    {
        foreach ($docs as $name => $field) {
            if (! isset($parameters[$name])) {
                continue;
            }

            if (($parameters[$name]['description'] ?? '') === '' && $field['description'] !== '') {
                $parameters[$name]['description'] = $field['description'];
            }

            if (isset($field['type'])) {
                $parameters[$name]['type'] = $field['type'];
            }

            if (array_key_exists('example', $field) && ($parameters[$name]['example'] ?? null) === null) {
                $parameters[$name]['example'] = $field['example'];
                $parameters[$name]['exampleWasSpecified'] = true;
            }
        }

        return $parameters;
    }
}
