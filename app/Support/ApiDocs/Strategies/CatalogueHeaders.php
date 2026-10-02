<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\Catalogue;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\Strategy;

/**
 * Extra request headers an endpoint documents (the webhook's signature). Content negotiation and the credential are added by Scribe itself.
 */
class CatalogueHeaders extends Strategy
{
    /**
     * @param  array<string, mixed>  $settings
     * @return array<string, string>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $settings = []): array
    {
        $doc = $endpointData->route === null ? null : Catalogue::for($endpointData->route);

        if ($doc === null) {
            return [];
        }

        return array_map(static fn (array $header): string => $header['value'], $doc->headers);
    }
}
