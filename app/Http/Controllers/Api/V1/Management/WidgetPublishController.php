<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\PublishWidget;
use App\Domain\Widgets\WidgetPresenter;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** `POST /widgets/{ulid}/publish`: draft becomes the visitor-facing config, version +1, caches busted. */
class WidgetPublishController extends ManagementController
{
    public function store(Request $request, Widget $widget, PublishWidget $action, WidgetPresenter $presenter): JsonResponse
    {
        return $this->data($presenter->data($action->handle($widget, $this->actor($request))));
    }
}
