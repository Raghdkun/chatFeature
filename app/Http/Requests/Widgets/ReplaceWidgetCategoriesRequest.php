<?php

namespace App\Http\Requests\Widgets;

use App\Http\Requests\Catalog\SyncCategoriesRequest;

/** Body of `PUT /api/v1/widgets/{ulid}/categories`: ordered `{ category_ulids }`. */
class ReplaceWidgetCategoriesRequest extends SyncCategoriesRequest {}
