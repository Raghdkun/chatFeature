<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\ReplaceCategories;
use App\Http\Requests\Widgets\ReplaceWidgetCategoriesRequest;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;

/** `PUT /widgets/{ulid}/categories`: replaces the enabled categories (the order is the display order). */
class WidgetCategoryController extends ManagementController
{
    public function update(ReplaceWidgetCategoriesRequest $request, Widget $widget, ReplaceCategories $action): JsonResponse
    {
        return $this->data(['category_ulids' => $action->handle($widget, $request->categoryUlids(), $this->actor($request))]);
    }
}
