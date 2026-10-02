<?php

namespace App\Support\ApiDocs;

use App\Support\ApiDocs\Strategies\CatalogueBodyParameters;
use App\Support\ApiDocs\Strategies\CatalogueHeaders;
use App\Support\ApiDocs\Strategies\CatalogueMetadata;
use App\Support\ApiDocs\Strategies\CatalogueQueryParameters;
use App\Support\ApiDocs\Strategies\CatalogueResponseFields;
use App\Support\ApiDocs\Strategies\CatalogueResponses;
use App\Support\ApiDocs\Strategies\CatalogueUrlParameters;
use Knuckles\Scribe\Config\AuthIn;
use Knuckles\Scribe\Extracting\Strategies\StaticData;
use Knuckles\Scribe\Scribe;

/**
 * The two Scribe configurations (`config/scribe.php` = Management, `config/scribe_public.php` = Public) built from one place, so
 * they cannot drift apart. Scribe is a dev dependency: the config files only call this when it is installed.
 *
 * What is deliberately different from Scribe's defaults:
 *  - nothing is learned from a running application: no response calls, no example models, no database; every success example comes
 *    from the Data classes and every error from the catalogue (see {@see Catalogue}), so generation is offline and deterministic;
 *  - URLs keep the route's own parameter names (`{conversation}`, not Scribe's renamed `{conversation_ulid}`);
 *  - the base URL is a fixed placeholder, never the installation's `APP_URL`, so the committed OpenAPI file does not depend on where
 *    it was generated.
 */
final class ScribeConfig
{
    public const BASE_URL = 'https://chat.example.com';

    /**
     * @param  string|null  $htmlPath  Where the static HTML goes (`API_DOCS_OUTPUT_*` in the config file); the audience's default when `null`.
     * @return array<string, mixed>
     */
    public static function for(ApiAudience $audience, ?string $htmlPath = null): array
    {
        Scribe::normalizeEndpointUrlUsing(static fn (string $uri): string => $uri);

        $management = $audience === ApiAudience::Management;

        return [
            'title' => $audience->title(),
            'description' => $management
                ? 'REST API for the staff dashboard and mobile apps: conversations, messages, presence, notifications, categories, agents, widgets and WhatsApp. Sanctum cookie or bearer token.'
                : 'REST API for visitor chat clients: widget config, sessions, chat, messages, attachments, rating, offline tickets and WhatsApp hand-off. Bearer visitor token, no cookies.',
            'intro_text' => self::intro($audience),
            'base_url' => self::BASE_URL,
            'routes' => [[
                'match' => [
                    'prefixes' => $management ? ['api/v1/*', 'webhooks/*'] : ['api/v1/public/*'],
                    'domains' => ['*'],
                ],
                'include' => $management ? [] : ApiAudience::DELIVERY_ROUTES,
                'exclude' => $management ? ['api/v1/public/*'] : [],
            ]],
            'type' => 'static',
            'theme' => 'default',
            'static' => ['output_path' => $htmlPath ?? $audience->htmlPath()],
            'laravel' => ['add_routes' => false, 'docs_url' => '/docs', 'assets_directory' => null, 'middleware' => []],
            'external' => ['html_attributes' => []],
            'try_it_out' => ['enabled' => false],
            'auth' => [
                'enabled' => true,
                'default' => false,
                'in' => AuthIn::BEARER->value,
                'name' => 'Authorization',
                'use_value' => null,
                'placeholder' => $management ? '{YOUR_API_TOKEN}' : '{VISITOR_TOKEN}',
                'extra_info' => $management
                    ? 'Send `Authorization: Bearer <id>|<secret>` (a staff API token, ability `staff`). The dashboard authenticates with the Sanctum session cookie plus `X-XSRF-TOKEN` instead. There is no password login endpoint yet: see the introduction.'
                    : 'Send `Authorization: Bearer vt_...`, the visitor token returned once by `POST /widgets/{key}/sessions`. Never put it in a URL.',
            ],
            'example_languages' => ['bash', 'javascript'],
            'postman' => ['enabled' => false],
            'openapi' => [
                'enabled' => true,
                'version' => '3.0.3',
                'overrides' => self::openApiOverrides($audience),
                'generators' => [SpecTidyGenerator::class],
            ],
            'groups' => ['default' => 'Other', 'order' => Catalogue::groupOrder($audience)],
            'logo' => false,
            'last_updated' => '',
            'examples' => ['faker_seed' => 1234, 'models_source' => []],
            'strategies' => [
                'metadata' => [CatalogueMetadata::class],
                'headers' => [
                    StaticData::withSettings(data: ['Content-Type' => 'application/json', 'Accept' => 'application/json']),
                    CatalogueHeaders::class,
                ],
                'urlParameters' => [CatalogueUrlParameters::class],
                'queryParameters' => [CatalogueQueryParameters::class],
                'bodyParameters' => [CatalogueBodyParameters::class],
                'responses' => [CatalogueResponses::class],
                'responseFields' => [CatalogueResponseFields::class],
            ],
            'database_connections_to_transact' => [],
            'fractal' => ['serializer' => null],
        ];
    }

    /**
     * The introduction: the audience's Markdown with its generated tables (error codes, rate limits) filled in from the code.
     */
    private static function intro(ApiAudience $audience): string
    {
        $markdown = (string) file_get_contents(resource_path('api-docs/'.$audience->value.'.md'));

        $limiters = match ($audience) {
            ApiAudience::Management => ['staff-api', 'push-subscriptions', 'push-test', 'wa-qr', 'wa-test', 'wa-webhook'],
            ApiAudience::Public => ['public-config', 'public-config-widget', 'public-session', 'public-network', 'public-message', 'public-upload', 'public-offline', 'broadcasting-auth', 'wa-handoff'],
        };

        return strtr($markdown, [
            '{{ERROR_TABLE}}' => self::errorTable($audience),
            '{{RATE_LIMITS}}' => RateLimitDocs::table($limiters),
        ]);
    }

    private static function errorTable(ApiAudience $audience): string
    {
        $rows = ['| Code | Status | Meaning |', '|---|---|---|'];

        foreach (ErrorCatalogue::forAudience($audience) as $code => $spec) {
            $rows[] = "| `{$code}` | {$spec['status']} | ".str_replace('|', '\\|', $spec['meaning']).' |';
        }

        return implode("\n", $rows);
    }

    /**
     * @return array<string, mixed>
     */
    private static function openApiOverrides(ApiAudience $audience): array
    {
        $management = $audience === ApiAudience::Management;

        return [
            'info.version' => 'v1',
            'info.contact.name' => 'PNE Chat',
            'info.license.name' => 'Proprietary',
            'components.securitySchemes.default' => $management
                ? ['type' => 'http', 'scheme' => 'bearer', 'description' => 'A staff API token: `Authorization: Bearer <id>|<secret>`. The dashboard uses the Sanctum session cookie with an `X-XSRF-TOKEN` header instead.']
                : ['type' => 'http', 'scheme' => 'bearer', 'description' => 'The visitor token `vt_...` from `POST /widgets/{key}/sessions`.'],
        ];
    }
}
