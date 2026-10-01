<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Audit\AuditLogger;
use App\Domain\Chat\Queries\ConversationListQuery;
use App\Domain\Chat\Services\ConversationExporter;
use App\Http\Requests\Chat\ListConversationsRequest;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * `GET /conversations/export?format=csv|json` + the list filters: admin only (route middleware), streamed in chunks (no cursor, no
 * limit: the whole filtered range), and recorded in the audit log because it hands out personal data in bulk.
 */
class ChatExportController extends ChatStaffController
{
    public function index(ListConversationsRequest $request, ConversationListQuery $conversations, ConversationExporter $exporter, AuditLogger $audit): StreamedResponse
    {
        $admin = $this->staff($request);
        $filters = $request->filters();
        $format = $request->validated('format') === 'json' ? 'json' : 'csv';

        $audit->record('conversations.exported', null, ['format' => $format, 'filters' => array_filter($filters, static fn (mixed $value): bool => $value !== null && $value !== [])], $admin);

        $query = $conversations->build($admin, $filters);
        $name = 'conversations-'.now()->utc()->format('Ymd-His').'.'.$format;

        return response()->stream(
            $format === 'json' ? $exporter->json($query) : $exporter->csv($query),
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
