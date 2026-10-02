<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\WhatsApp\HandoffData;
use App\Domain\WhatsApp\Actions\CreateHandoff;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\WhatsApp\HandoffRequest;
use Illuminate\Http\JsonResponse;

/**
 * `POST /public/widgets/{key}/whatsapp-handoff`: the visitor's hand-off to WhatsApp. The visitor bearer is bound to ONE widget, and `{key}`
 * must be that widget (anything else is the same `404 widget_not_found` an unknown key gets). The answer is exactly `{code, waUrl, expiresAt}`:
 * `201` for a new code, `200` when the visitor's live code for that topic is handed back.
 */
class WhatsAppHandoffController extends ChatVisitorController
{
    public function store(HandoffRequest $request, string $key, CreateHandoff $action): JsonResponse
    {
        if ($this->widget($request)->public_key !== $key) {
            throw ApiProblemException::notFound('widget_not_found', __('This widget does not exist or is disabled.'));
        }

        $result = $action->handle($this->session($request), $request->category());

        return $this->data(HandoffData::fromTicket($result['ticket']), $result['created'] ? 201 : 200);
    }
}
