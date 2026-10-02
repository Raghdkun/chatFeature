<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Actions\CreateWhatsAppSession;
use App\Domain\WhatsApp\Actions\DeleteWhatsAppSession;
use App\Domain\WhatsApp\Actions\UpdateSessionPacing;
use App\Http\Requests\WhatsApp\CreateSessionRequest;
use App\Http\Requests\WhatsApp\UpdateSessionRequest;
use App\Models\WhatsAppSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/** `GET/POST /whatsapp/sessions`, `GET/PATCH/DELETE /whatsapp/sessions/{ulid}`: the WhatsApp numbers (admin only). */
class WhatsAppSessionController extends WhatsAppController
{
    public function index(): JsonResponse
    {
        $sessions = WhatsAppSession::query()->withCount('widgets')->orderBy('id')->get();

        return $this->list($sessions->map(fn (WhatsAppSession $session): WhatsAppSessionData => WhatsAppSessionData::fromModel($session)));
    }

    public function store(CreateSessionRequest $request, CreateWhatsAppSession $action): JsonResponse
    {
        $session = $action->handle((string) $request->validated('name'), $this->admin($request));

        return $this->data(WhatsAppSessionData::fromModel($session->loadCount('widgets')), 201);
    }

    public function show(WhatsAppSession $session): JsonResponse
    {
        return $this->data(WhatsAppSessionData::fromModel($session->loadCount('widgets')));
    }

    public function update(UpdateSessionRequest $request, WhatsAppSession $session, UpdateSessionPacing $action): JsonResponse
    {
        $updated = $action->handle($session, $request->pacing(), $this->admin($request));

        return $this->data(WhatsAppSessionData::fromModel($updated->loadCount('widgets')));
    }

    public function destroy(Request $request, WhatsAppSession $session, DeleteWhatsAppSession $action): Response
    {
        $action->handle($session, $this->admin($request), $request->boolean('force'));

        return response()->noContent();
    }
}
