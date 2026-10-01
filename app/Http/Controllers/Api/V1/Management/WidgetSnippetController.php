<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Embed\EmbedSnippetBuilder;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;

/** `GET /widgets/{ulid}/snippet`: embed codes and identity-JWT examples. */
class WidgetSnippetController extends ManagementController
{
    public function show(Widget $widget, EmbedSnippetBuilder $snippets): JsonResponse
    {
        return $this->data($snippets->build($widget));
    }
}
