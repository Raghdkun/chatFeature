<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Domain\Widgets\Availability\AvailabilityService;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `GET /api/v1/public/widgets/{key}/availability`: online / open now / next opening, per category. Short browser cache
 * on top of the 8 s server-side cache.
 */
class WidgetAvailabilityController extends PublicWidgetController
{
    public function show(Request $request, AvailabilityService $availability): Response
    {
        $data = $availability->arrayFor($this->widget($request));

        return $this->cacheableJson($request, ['data' => $data], $data, 'public, max-age=5');
    }
}
