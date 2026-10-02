<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Queries\WaChatListQuery;
use App\Domain\WhatsApp\Services\WaExporter;
use App\Http\Requests\WhatsApp\ListChatsRequest;
use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * `GET /whatsapp/export?format=csv|json&resource=messages|chats` + the inbox filters (`status` defaults to `all` here) and `from` / `to`
 * (message time): administrators only, streamed in chunks (no cursor, no limit), `Content-Disposition: attachment`, formula-injection safe,
 * and recorded in the audit log because it hands out personal data in bulk.
 */
class WhatsAppExportController extends WhatsAppController
{
    public function index(ListChatsRequest $request, WaChatListQuery $chats, WaExporter $exporter, AuditLogger $audit): StreamedResponse
    {
        $admin = $this->admin($request);
        Gate::forUser($admin)->authorize('export', WaChat::class);

        $format = $request->validated('format') === 'json' ? 'json' : 'csv';
        $messages = $request->validated('resource') !== 'chats';
        $filters = $request->filters();
        $filters['status'] ??= 'all';
        $range = array_filter(['from' => $request->validated('from'), 'to' => $request->validated('to')], static fn (mixed $value): bool => $value !== null);

        $audit->record('whatsapp.exported', null, [
            'format' => $format,
            'resource' => $messages ? 'messages' : 'chats',
            'filters' => array_filter([...$filters, ...$range], static fn (mixed $value): bool => $value !== null && $value !== ''),
        ], $admin);

        $chatIds = $chats->build($filters)->select('wa_chats.id');

        if ($messages) {
            $query = WaMessage::query()->whereIn('wa_messages.wa_chat_id', $chatIds);

            if (isset($range['from'])) {
                $query->where('wa_messages.wa_timestamp', '>=', WaChatListQuery::instant((string) $range['from']));
            }

            if (isset($range['to'])) {
                $query->where('wa_messages.wa_timestamp', '<=', WaChatListQuery::instant((string) $range['to'], endOfBareDate: true));
            }
        } else {
            $query = $chats->build($filters);
        }

        $name = 'whatsapp-'.($messages ? 'messages' : 'chats').'-'.now()->utc()->format('Ymd-His').'.'.$format;

        return response()->stream(
            $format === 'json' ? $exporter->json($query, $messages) : $exporter->csv($query, $messages),
            200,
            [
                'Content-Type' => $format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
                'Content-Disposition' => 'attachment; filename="'.$name.'"',
                'Cache-Control' => 'no-store',
                'X-Accel-Buffering' => 'no',
                'X-Content-Type-Options' => 'nosniff',
            ],
        );
    }
}
