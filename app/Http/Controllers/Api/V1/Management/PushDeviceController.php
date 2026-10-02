<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Notifications\DeviceTokenData;
use App\Domain\Notifications\Actions\RegisterDeviceToken;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Notifications\RegisterDeviceRequest;
use App\Models\DeviceToken;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `POST/DELETE /me/devices`: mobile devices' FCM tokens, for the future mobile app (a stub, decision P5-D4: stored, nothing sent yet).
 * Scoped to the caller like the browser subscriptions; the token is never returned.
 */
class PushDeviceController extends ChatStaffController
{
    public function store(RegisterDeviceRequest $request, RegisterDeviceToken $action): JsonResponse
    {
        $device = $action->handle($this->staff($request), (string) $request->validated('platform'), (string) $request->validated('token'));

        return $this->data(DeviceTokenData::fromModel($device), $device->wasRecentlyCreated ? 201 : 200);
    }

    public function destroy(Request $request, string $device): Response
    {
        $row = DeviceToken::query()->ownedBy($this->staff($request))->where('ulid', $device)->first();

        if ($row === null) {
            throw ApiProblemException::notFound('device_not_found', __('This device is not registered.'));
        }

        $row->delete();

        return response()->noContent();
    }
}
