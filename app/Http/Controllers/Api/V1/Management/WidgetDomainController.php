<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\ReplaceDomains;
use App\Http\Requests\Widgets\ReplaceDomainsRequest;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;

/** `PUT /widgets/{ulid}/domains`: replaces the allowed embedding hosts with their normalised form. */
class WidgetDomainController extends ManagementController
{
    public function update(ReplaceDomainsRequest $request, Widget $widget, ReplaceDomains $action): JsonResponse
    {
        return $this->data(['domains' => $action->handle($widget, $request->normalizedDomains(), $this->actor($request))]);
    }
}
