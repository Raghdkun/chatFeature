<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Widgets\GreetingData;
use App\Data\Widgets\WidgetData;
use App\Data\Widgets\WidgetListItemData;
use App\Data\Widgets\WidgetSnippetsData;
use App\Support\ApiDocs\Doc;
use App\Support\ApiDocs\ExampleValues;

/** The embeddable widgets (administrators only). */
final class WidgetEntries implements EntryList
{
    public static function docs(): array
    {
        return [
            Doc::route('api.widgets.index')
                ->in('Widgets', 'Settings')
                ->title('List widgets')
                ->about('Complete list, ordered by name. Responses never contain the identity secret.')
                ->list(WidgetListItemData::class),

            Doc::route('api.widgets.store')
                ->in('Widgets', 'Settings')
                ->title('Create a widget')
                ->about('Created **disabled**, with the default config and no identity secret. Enable it with `PATCH` and publish when it is ready.')
                ->created(WidgetData::class),

            Doc::route('api.widgets.show')
                ->in('Widgets', 'Settings')
                ->title('Show a widget')
                ->item(WidgetData::class),

            Doc::route('api.widgets.update')
                ->in('Widgets', 'Settings')
                ->title('Update a widget')
                ->about('Operational settings, every field optional; they apply to visitors at once (the config itself goes through draft and publish).')
                ->item(WidgetData::class)
                ->errors(['validation_failed' => 'A value is invalid or out of range.']),

            Doc::route('api.widgets.destroy')
                ->in('Widgets', 'Settings')
                ->title('Delete a widget')
                ->about('A soft delete: visitors of the widget get `404 widget_not_found` from then on.')
                ->noContent(204, 'Deleted.'),

            Doc::route('api.widgets.draft')
                ->in('Widgets', 'Config')
                ->title('Save the draft config')
                ->about("Stores the complete config as the widget's **draft** after strict validation (unknown keys, ranges, colours and URLs are refused with details under `config.*`). Visitors keep seeing the published config; `has_unpublished_changes` says the two differ.")
                ->item(WidgetData::class)
                ->errors(['validation_failed' => 'The config is invalid: `details` is keyed by dotted path under `config` (`config.theme.panelHeight`).']),

            Doc::route('api.widgets.publish')
                ->in('Widgets', 'Config')
                ->title('Publish the draft')
                ->about('Copies the draft to the visitor-facing config, writes the mirrored columns, bumps `config_version` and drops the widget\'s cached config and availability.')
                ->item(WidgetData::class),

            Doc::route('api.widgets.domains')
                ->in('Widgets', 'Embedding')
                ->title('Replace the allowed domains')
                ->about('The hosts that may embed the widget and call the public config API from a browser. Each entry is normalised (lower case, punycode, no path; `*.` only as the first label and never on a public suffix such as `*.co.uk`; an optional port). A bare entry admits https only; `http://` is the explicit permission for a plain-http site. Applies immediately; the normalised list comes back.')
                ->data(['domains' => ['example.com', '*.example.org']], 200, '', ['domains' => ['type' => 'string[]', 'description' => 'The normalised, de-duplicated entries.']])
                ->errors(['validation_failed' => '`details.domains.N` says which entry is not a valid host.']),

            Doc::route('api.widgets.categories')
                ->in('Widgets', 'Embedding')
                ->title('Replace the widget\'s categories')
                ->about('The topics enabled on the widget, in display order. Applies immediately.')
                ->data(['category_ulids' => [ExampleValues::ulid('category')]], 200, '', ['category_ulids' => ['type' => 'string[]', 'description' => 'The categories in display order.']])
                ->errors(['validation_failed' => 'An entry is not an existing category.']),

            Doc::route('api.widgets.greetings')
                ->in('Widgets', 'Embedding')
                ->title('Replace the greeting pool')
                ->about('The complete pool (at most 100). Entries with a `ulid` of this widget keep their identity, entries without one are created, everything omitted is deleted. Greeting bodies are plain text, never HTML. Applies immediately.')
                ->list(GreetingData::class)
                ->errors(['validation_failed' => 'A greeting is invalid or its `ulid` belongs to another widget.']),

            Doc::route('api.widgets.rotate-secret')
                ->in('Widgets', 'Embedding')
                ->title('Rotate the identity secret')
                ->about("Creates a new secret for signing visitor identities (HS256 JWT) and returns it **once**, in plaintext, with `Cache-Control: no-store`. Tokens signed with the old secret stop verifying immediately. Store the secret on the host website's backend only, never in browser code.")
                ->data(['identity_secret' => 'f3c1d0a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5'], 200, '', ['identity_secret' => ['type' => 'string', 'description' => 'The new secret. Shown once.']]),

            Doc::route('api.widgets.snippet')
                ->in('Widgets', 'Embedding')
                ->title('Show the embed codes')
                ->about('The script tag, iframe and hosted page for the dashboard, plus copy-paste code that mints the signed visitor identity. Placeholders only: the secret is never in it.')
                ->item(WidgetSnippetsData::class),
        ];
    }
}
