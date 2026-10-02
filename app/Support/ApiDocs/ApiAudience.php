<?php

namespace App\Support\ApiDocs;

/**
 * The two audiences of the generated API reference (one Scribe config and one OpenAPI file each):
 *
 *  - Management: `/api/v1/*` for staff (Sanctum cookie for the dashboard, bearer for a mobile app) plus the inbound
 *    webhooks of the WhatsApp gateway;
 *  - Public: `/api/v1/public/*` for visitors (`vt_...` bearer) plus the loader and iframe delivery routes a custom
 *    front end starts from.
 */
enum ApiAudience: string
{
    case Management = 'management';
    case Public = 'public';

    /** Routes outside `api/v1` that belong to the public reference (script and page delivery). */
    public const DELIVERY_ROUTES = ['embed.script', 'embed.loader', 'embed.frame', 'embed.hosted'];

    /** The Scribe config file (`config/<name>.php`, `php artisan scribe:generate --config=<name>`). */
    public function configName(): string
    {
        return match ($this) {
            self::Management => 'scribe',
            self::Public => 'scribe_public',
        };
    }

    public function title(): string
    {
        return match ($this) {
            self::Management => 'PNE Chat Management API',
            self::Public => 'PNE Chat Public (visitor) API',
        };
    }

    /** The committed, reviewable OpenAPI file. */
    public function specPath(): string
    {
        return base_path('docs/api/openapi-'.$this->value.'.yaml');
    }

    /** Where the static HTML reference is written (git-ignored, relative to the project root). */
    public function htmlPath(): string
    {
        return 'public/docs/'.$this->value;
    }

    /** The audience a route belongs to, `null` for everything outside the documented API surface. */
    public static function forUri(string $uri, ?string $routeName = null): ?self
    {
        $uri = ltrim($uri, '/');

        if (str_starts_with($uri, 'api/v1/public/') || ($routeName !== null && in_array($routeName, self::DELIVERY_ROUTES, true))) {
            return self::Public;
        }

        if (str_starts_with($uri, 'api/v1/') || str_starts_with($uri, 'webhooks/')) {
            return self::Management;
        }

        return null;
    }
}
