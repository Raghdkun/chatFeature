<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\Catalogue;
use App\Support\ApiDocs\RequestDocs;
use Illuminate\Foundation\Http\FormRequest;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\GetFromFormRequestBase;

/**
 * The body of a write endpoint: the rules of its Form Request with the descriptions and examples of {@see RequestDocs}, plus the
 * parameters of endpoints that read their input without a Form Request (`Doc::param()`).
 */
class CatalogueBodyParameters extends GetFromFormRequestBase
{
    protected string $customParameterDataMethodName = 'bodyParameters';

    /**
     * @param  array<string, mixed>  $routeRules
     * @return array<string, array<string, mixed>>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $routeRules = []): array
    {
        if ($endpointData->route === null || in_array($endpointData->route->methods()[0], ['GET', 'HEAD'], true)) {
            return [];
        }

        $doc = Catalogue::for($endpointData->route);
        $parameters = $this->getParametersFromFormRequest($endpointData->method, $endpointData->route);
        $request = $this->formRequestClass($endpointData);

        if ($request !== null) {
            $parameters = ApplyRequestDocs::to($parameters, RequestDocs::for($request));
        }

        foreach ($doc->body ?? [] as $name => $field) {
            $parameters[$name] = [
                'name' => $name,
                'type' => 'string',
                'required' => true,
                'description' => $field['description'],
                'example' => $field['example'] ?? null,
                'exampleWasSpecified' => array_key_exists('example', $field),
            ];
        }

        return HidesParameters::from($parameters, $doc->hidden ?? []);
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
