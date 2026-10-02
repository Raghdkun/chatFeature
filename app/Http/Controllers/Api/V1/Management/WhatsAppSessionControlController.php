<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WhatsAppQrData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Actions\FetchSessionQr;
use App\Domain\WhatsApp\Actions\StartWhatsAppSession;
use App\Domain\WhatsApp\Actions\StopWhatsAppSession;
use App\Domain\WhatsApp\Actions\SyncWhatsAppSession;
use App\Models\WhatsAppSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `POST .../start` (202: the engine starts in a queued job), `POST .../stop`, `POST .../sync` and `GET .../qr` (the pairing code, only
 * while the session waits for a scan, never cached).
 */
class WhatsAppSessionControlController extends WhatsAppController
{
    public function start(Request $request, WhatsAppSession $session, StartWhatsAppSession $action): JsonResponse
    {
        return $this->data(WhatsAppSessionData::fromModel($action->handle($session, $this->admin($request))->loadCount('widgets')), 202);
    }

    public function stop(Request $request, WhatsAppSession $session, StopWhatsAppSession $action): JsonResponse
    {
        return $this->data(WhatsAppSessionData::fromModel($action->handle($session, $this->admin($request))->loadCount('widgets')));
    }

    public function sync(Request $request, WhatsAppSession $session, SyncWhatsAppSession $action): JsonResponse
    {
        return $this->data(WhatsAppSessionData::fromModel($action->handle($session, $this->admin($request))->loadCount('widgets')));
    }

    public function qr(Request $request, WhatsAppSession $session, FetchSessionQr $action): JsonResponse
    {
        $qr = $action->handle($session, $this->admin($request));

        return $this->data(WhatsAppQrData::make($qr['qr'], $qr['updatedAt']))->withHeaders(['Cache-Control' => 'no-store, private', 'Pragma' => 'no-cache']);
    }
}
