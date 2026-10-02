<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\CreateWidget;
use App\Domain\Widgets\Actions\DeleteWidget;
use App\Domain\Widgets\Actions\UpdateWidget;
use App\Domain\Widgets\WidgetPresenter;
use App\Http\Requests\Widgets\StoreWidgetRequest;
use App\Http\Requests\Widgets\UpdateWidgetRequest;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Widget CRUD (admin only). Responses never contain the identity secret.
 */
class WidgetController extends ManagementController
{
    public function index(WidgetPresenter $presenter): JsonResponse
    {
        $widgets = Widget::query()->with('whatsappSession')->withCount(['domains', 'categories'])->orderBy('name')->orderBy('id')->get();

        return $this->list($presenter->listItems($widgets));
    }

    public function store(StoreWidgetRequest $request, CreateWidget $action, WidgetPresenter $presenter): JsonResponse
    {
        $widget = $action->handle((string) $request->validated('name'), $this->actor($request));

        return $this->data($presenter->data($widget), 201);
    }

    public function show(Widget $widget, WidgetPresenter $presenter): JsonResponse
    {
        return $this->data($presenter->data($widget));
    }

    public function update(UpdateWidgetRequest $request, Widget $widget, UpdateWidget $action, WidgetPresenter $presenter): JsonResponse
    {
        return $this->data($presenter->data($action->handle($widget, $request->validated(), $this->actor($request))));
    }

    public function destroy(Request $request, Widget $widget, DeleteWidget $action): Response
    {
        $action->handle($widget, $this->actor($request));

        return response()->noContent();
    }
}
