<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\SaveDraft;
use App\Domain\Widgets\WidgetPresenter;
use App\Http\Requests\Widgets\SaveDraftRequest;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;

/**
 * `PUT /widgets/{ulid}/draft`: strict validation (unknown keys, ranges, colours, URLs -> 422 with field errors under `config.*`),
 * then the draft is stored. Visitors keep seeing the published config.
 */
class WidgetDraftController extends ManagementController
{
    public function update(SaveDraftRequest $request, Widget $widget, SaveDraft $action, WidgetPresenter $presenter): JsonResponse
    {
        return $this->data($presenter->data($action->handle($widget, $request->input('config'), $this->actor($request))));
    }
}
