<?php

namespace App\Http\Controllers\Webhooks;

use App\Domain\WhatsApp\Actions\ReceiveWebhookDelivery;
use App\Http\Controllers\Controller;
use App\Models\WhatsAppSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * `POST /webhooks/openwa/{session}` (bearer-only `widget` group: no session, no cookies, no CSRF). The signature was verified by
 * `VerifyOpenWaSignature` before this runs; the delivery is stored and handed to the queue, and OpenWA is answered at once:
 * `200 {status: accepted | duplicate | rejected}`.
 */
class OpenWaWebhookController extends Controller
{
    public function __invoke(Request $request, ReceiveWebhookDelivery $action): JsonResponse
    {
        $session = $request->attributes->get('openwa_session');

        if (! $session instanceof WhatsAppSession) {
            throw new NotFoundHttpException;
        }

        $status = $action->handle(
            $session,
            $request->getContent(),
            $request->headers->get('X-OpenWA-Idempotency-Key'),
            $request->headers->get('X-OpenWA-Event'),
            $request->headers->get('X-OpenWA-Delivery-Id'),
        );

        return response()->json(['status' => $status])->header('Cache-Control', 'no-store');
    }
}
