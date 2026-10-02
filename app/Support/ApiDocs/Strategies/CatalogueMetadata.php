<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\ApiRoutes;
use App\Support\ApiDocs\Catalogue;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\Strategy;
use RuntimeException;

/**
 * Group, title and description of an endpoint from the catalogue; whether it needs a credential from the route's middleware
 * (a Sanctum guard or the visitor token), so the "authenticated" mark can never disagree with the route.
 */
class CatalogueMetadata extends Strategy
{
    /**
     * @param  array<string, mixed>  $settings
     * @return array<string, mixed>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $settings = []): array
    {
        $route = $endpointData->route ?? throw new RuntimeException('Endpoint without a route.');
        $doc = Catalogue::for($route) ?? throw new RuntimeException('No API reference entry for route ['.($route->getName() ?? ApiRoutes::label($route)).']: add one to App\Support\ApiDocs\Entries.');

        return [
            'groupName' => $doc->group,
            'groupDescription' => Catalogue::groupDescription($doc->group),
            'subgroup' => $doc->subgroup ?? '',
            'subgroupDescription' => $doc->subgroup === null ? '' : Catalogue::subgroupDescription($doc->group, $doc->subgroup),
            'title' => $doc->title,
            'description' => $doc->describe($route),
            'authenticated' => ApiRoutes::isAuthenticated($route),
        ];
    }
}
