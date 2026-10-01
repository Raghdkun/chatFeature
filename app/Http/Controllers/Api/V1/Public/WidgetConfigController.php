<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Domain\Widgets\Config\ConfigResolver;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `GET /api/v1/public/widgets/{key}/config?locale=xx`: the ResolvedBootConfig (published config only).
 */
class WidgetConfigController extends PublicWidgetController
{
    public function show(Request $request, ConfigResolver $resolver): Response
    {
        $boot = $resolver->resolveArray($this->widget($request), $request->query('locale'));

        $versioned = $boot;
        unset($versioned['generatedAt']);

        return $this->cacheableJson($request, ['data' => $boot], $versioned, 'public, max-age=60, stale-while-revalidate=300');
    }
}
