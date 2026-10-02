<?php

namespace App\Support\ApiDocs;

use Spatie\LaravelData\Data;

/**
 * One documented success answer of an endpoint ({@see Doc}).
 *
 * `kind`: `item` / `list` / `paged` (a Data class in the `{ data }` envelope), `data` (a hand-built `{ data }` payload), `plain` (a
 * hand-built body without the envelope), `none` (no body) or `raw` (non-JSON).
 *
 * @phpstan-type FieldNote array{description: string, type?: string}
 */
final readonly class Success
{
    /**
     * @param  class-string<Data>|null  $class
     * @param  array<string, string>  $headers
     * @param  array<string, FieldNote>  $fields
     */
    public function __construct(
        public int $status,
        public string $kind,
        public ?string $class,
        public mixed $example,
        public string $note,
        public bool $staff,
        public array $headers = [],
        public array $fields = [],
        public bool $nullable = false,
    ) {}
}
