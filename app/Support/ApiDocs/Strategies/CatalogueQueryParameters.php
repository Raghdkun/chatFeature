<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\Catalogue;
use App\Support\ApiDocs\RequestDocs;
use Illuminate\Foundation\Http\FormRequest;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\GetFromFormRequestBase;

/**
 * The query string of a GET endpoint: the rules of its Form Request (types, limits, enum values) with the descriptions and examples
 * of {@see RequestDocs}. Scribe only treats a Form Request as a query when its docblock says "query parameters"; here every
 * Form Request of a GET route is one.
 */
class CatalogueQueryParameters extends GetFromFormRequestBase
{
    protected string $customParameterDataMethodName = 'queryParameters';

    /**
     * @param  array<string, mixed>  $routeRules
     * @return array<string, array<string, mixed>>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $routeRules = []): array
    {
        if ($endpointData->route === null || ! in_array($endpointData->route->methods()[0], ['GET', 'HEAD'], true)) {
            return [];
        }

        $parameters = $this->getParametersFromFormRequest($endpointData->method, $endpointData->route);
        $request = $this->formRequestClass($endpointData);

        if ($request !== null) {
            $parameters = ApplyRequestDocs::to($parameters, RequestDocs::for($request));
        }

        return HidesParameters::from($parameters, Catalogue::for($endpointData->route)->hidden ?? []);
    }

    /**
     * @param  \ReflectionClass<object>  $formRequestReflectionClass
     */
    protected function isFormRequestMeantForThisStrategy(\ReflectionClass $formRequestReflectionClass): bool
    {
        return true;
    }

    /**
     * @return array<string, array{description: string, example?: mixed}>
     */
    protected function getCustomParameterData(FormRequest $formRequest): array
    {
        return RequestDocs::for($formRequest::class);
    }

    private function formRequestClass(ExtractedEndpointData $endpointData): ?string
    {
        return $this->getFormRequestReflectionClass($endpointData->method)?->getName();
    }
}
