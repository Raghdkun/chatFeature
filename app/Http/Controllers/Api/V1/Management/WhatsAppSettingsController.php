<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WhatsAppConnectionTestData;
use App\Data\WhatsApp\WhatsAppSettingsData;
use App\Domain\WhatsApp\Actions\TestOpenWaConnection;
use App\Domain\WhatsApp\Actions\UpdateWhatsAppSettings;
use App\Http\Requests\WhatsApp\UpdateSettingsRequest;
use App\Models\WhatsAppSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/** `GET/PUT /whatsapp/settings` (the API key is write-only) and `POST /whatsapp/settings/test` (the saved address and key). Admin only. */
class WhatsAppSettingsController extends WhatsAppController
{
    public function show(Request $request): JsonResponse
    {
        Gate::forUser($this->admin($request))->authorize('manageSettings', WhatsAppSession::class);

        return $this->data(WhatsAppSettingsData::fromSettings())->withHeaders(['Cache-Control' => 'no-store, private']);
    }

    public function update(UpdateSettingsRequest $request, UpdateWhatsAppSettings $action): JsonResponse
    {
        /** @var array<string, mixed> $input */
        $input = $request->validated();
        $action->handle($input, $this->admin($request));

        return $this->data(WhatsAppSettingsData::fromSettings())->withHeaders(['Cache-Control' => 'no-store, private']);
    }

    public function test(Request $request, TestOpenWaConnection $action): JsonResponse
    {
        return $this->data(new WhatsAppConnectionTestData(...$action->handle($this->admin($request))));
    }
}
