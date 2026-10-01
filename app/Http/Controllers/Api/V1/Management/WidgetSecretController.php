<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Widgets\Actions\RotateIdentitySecret;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `POST /widgets/{ulid}/rotate-secret`: the only response that ever contains the identity secret, in plaintext, once.
 */
class WidgetSecretController extends ManagementController
{
    public function store(Request $request, Widget $widget, RotateIdentitySecret $action): JsonResponse
    {
        $secret = $action->handle($widget, $this->actor($request));

        return $this->data(['identity_secret' => $secret])->header('Cache-Control', 'no-store');
    }
}
