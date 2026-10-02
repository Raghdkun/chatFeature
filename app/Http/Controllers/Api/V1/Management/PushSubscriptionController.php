<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Notifications\PushSubscriptionData;
use App\Data\Notifications\PushTestResultData;
use App\Domain\Notifications\Actions\SendTestPush;
use App\Domain\Notifications\Actions\StorePushSubscription;
use App\Domain\Notifications\Channels\WebPushChannel;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Notifications\StorePushSubscriptionRequest;
use App\Models\PushSubscription;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * The caller's own browsers that receive web push (decision P5-D9): list, register (upsert by endpoint), remove, and the test push.
 * Every query is scoped to the signed-in user, so another user's subscription id is a plain `404`, never a `403` that confirms it exists.
 * The endpoint and keys are never returned.
 */
class PushSubscriptionController extends ChatStaffController
{
    public function index(Request $request): JsonResponse
    {
        $subscriptions = PushSubscription::query()->ownedBy($this->staff($request))->orderByDesc('created_at')->orderByDesc('id')->get();

        return $this->list($subscriptions->map(fn (PushSubscription $subscription): PushSubscriptionData => PushSubscriptionData::fromModel($subscription)));
    }

    public function store(StorePushSubscriptionRequest $request, StorePushSubscription $action): JsonResponse
    {
        $this->requirePush();

        [$subscription, $created] = $action->handle(
            $this->staff($request),
            $request->subscription(),
            $request->userAgent(),
            $request->hasSession() ? $request->session()->getId() : null,
        );

        return $this->data(PushSubscriptionData::fromModel($subscription), $created ? 201 : 200);
    }

    public function destroy(Request $request, string $subscription): Response
    {
        $row = PushSubscription::query()->ownedBy($this->staff($request))->where('ulid', $subscription)->first();

        if ($row === null) {
            throw ApiProblemException::notFound('subscription_not_found', __('This device is not registered.'));
        }

        $row->delete();

        return response()->noContent();
    }

    public function test(Request $request, SendTestPush $action): JsonResponse
    {
        $this->requirePush();

        $user = $this->staff($request);

        if (! PushSubscription::query()->ownedBy($user)->exists()) {
            throw ApiProblemException::conflict('no_push_devices', __('No browser is registered for notifications yet.'));
        }

        $result = $action->handle($user);

        return $this->data(new PushTestResultData(...$result));
    }

    /** Without the VAPID keys there is nothing to subscribe to and nothing to send with. */
    private function requirePush(): void
    {
        if (! WebPushChannel::vapidConfigured()) {
            throw new ApiProblemException(503, 'push_unavailable', __('Push notifications are not set up on this server.'));
        }
    }
}
