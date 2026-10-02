<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\Catalogue;
use App\Support\ApiDocs\DataShape;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\Strategy;

/**
 * The fields of the success payloads: type, nullability, enum values, required and the description from `FieldDocs`, all read from
 * the Data classes the entry names (paths below `data`, no list indexes), plus the paging fields of lists.
 */
class CatalogueResponseFields extends Strategy
{
    /**
     * @param  array<string, mixed>  $settings
     * @return array<string, array<string, mixed>>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $settings = []): array
    {
        $doc = $endpointData->route === null ? null : Catalogue::for($endpointData->route);

        if ($doc === null) {
            return [];
        }

        $fields = [];
        $shape = new DataShape;

        foreach ($doc->successes as $success) {
            if ($success->class !== null) {
                foreach ($shape->describe($success->class, 'data', $success->staff)['fields'] as $path => $field) {
                    $fields[$path] = [
                        'name' => $path,
                        'type' => $field['type'],
                        'description' => $field['description'],
                        'required' => $field['required'],
                        'nullable' => $field['nullable'],
                        'enumValues' => $field['enum'],
                    ];
                }
            }

            if ($success->nullable) {
                $fields['data'] = ['name' => 'data', 'type' => 'object', 'description' => 'The resource, or `null` when there is none.', 'required' => true, 'nullable' => true];
            }

            foreach ($success->fields as $path => $note) {
                $fields['data.'.$path] = ['name' => 'data.'.$path, 'type' => $note['type'] ?? 'string', 'description' => $note['description'], 'required' => true, 'nullable' => false];
            }

            if ($success->kind === 'paged') {
                foreach ((array) $success->example as $key => $value) {
                    $fields['meta.'.$key] = ['name' => 'meta.'.$key, 'type' => is_int($value) ? 'integer' : 'string', 'description' => '', 'required' => true, 'nullable' => $value === null];
                }
            }

            if (in_array($success->kind, ['list', 'paged'], true)) {
                $fields['meta.next_cursor'] = [
                    'name' => 'meta.next_cursor',
                    'type' => 'string',
                    'description' => $success->kind === 'paged'
                        ? 'Opaque cursor of the next page: pass it as `cursor` to continue. `null` on the last page.'
                        : 'Always `null`: this list is complete and not paginated.',
                    'required' => true,
                    'nullable' => true,
                ];
            }
        }

        return $fields;
    }
}
