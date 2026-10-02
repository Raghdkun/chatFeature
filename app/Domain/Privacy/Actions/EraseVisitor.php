<?php

namespace App\Domain\Privacy\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Privacy\ErasureReport;
use App\Domain\Visitors\Events\VisitorSessionsEnded;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Visitor;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

/**
 * Erases one visitor for good (`DELETE /api/v1/visitors/{ulid}`, `chat:erase-visitor`): the identity (name, e-mail, phone, the host's id,
 * unverified meta), every session (page URLs, user agent), every conversation with its messages, attachments (the FILES too), ratings,
 * timeline events, offers, offline tickets and the staff's recorded subscriptions to them. Administrators only (`VisitorPolicy`, asked again
 * here). The visitor's websockets are closed.
 *
 * - **Idempotent**: a visitor that is already gone is a success and changes nothing (`erased: false`).
 * - **Not while a chat is open**: a queued or active conversation would vanish from an agent's screen; the administrator ends it first
 *   (`409 visitor_has_open_chat`).
 * - **Files first**: the image files go before the rows. A file that cannot be deleted aborts the erasure with nothing lost but the files
 *   that were already removed; running it again finishes the job. (The other order would leave unreferenced files nobody lists.)
 * - **What stays**: the audit entry (ids and counts, no name / address / text), the analytics rollups (counts and sums, no personal data),
 *   a WhatsApp chat that was linked to the visitor by a hand-off code (it becomes unlinked: it is a separate record with its own erasure,
 *   `DELETE /whatsapp/chats/{ulid}`), and copies outside the application (backups, mail already sent, the log files: see docs/security.md).
 */
final class EraseVisitor
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function handle(Visitor $visitor, ?User $actor): ErasureReport
    {
        if ($actor !== null) {
            Gate::forUser($actor)->authorize('erase', $visitor);
        }

        $open = Conversation::query()->where('visitor_id', $visitor->id)->whereIn('status', ConversationStatus::openValues())->count();

        if ($open > 0) {
            throw new ApiProblemException(409, 'visitor_has_open_chat', __('This visitor has a chat that is still open. End or close it first.'), ['openConversations' => $open]);
        }

        $attachments = Attachment::query()
            ->whereIn('conversation_id', Conversation::query()->where('visitor_id', $visitor->id)->select('id'))
            ->get(['id', 'disk', 'path', 'thumb_path']);
        $sessionIds = array_values($visitor->sessions()->pluck('id')->map(fn ($id): int => (int) $id)->all());

        $this->deleteFiles($attachments);

        $counts = DeadlockRetry::transaction(function () use ($visitor, $attachments): ?array {
            if (Visitor::query()->whereKey($visitor->id)->lockForUpdate()->first() === null) {
                return null;
            }

            $conversations = Conversation::query()->where('visitor_id', $visitor->id)->pluck('id');
            $counts = [
                'sessions' => $visitor->sessions()->count(),
                'conversations' => $conversations->count(),
                'offlineTickets' => Conversation::query()->where('visitor_id', $visitor->id)->where('type', 'offline')->count(),
                'messages' => $conversations->isEmpty() ? 0 : DB::table('messages')->whereIn('conversation_id', $conversations)->count(),
                'attachments' => $attachments->count(),
                'ratings' => $conversations->isEmpty() ? 0 : DB::table('ratings')->whereIn('conversation_id', $conversations)->count(),
                'events' => $conversations->isEmpty() ? 0 : DB::table('conversation_events')->whereIn('conversation_id', $conversations)->count(),
                'whatsappChatsUnlinked' => DB::table('wa_chats')->where('visitor_id', $visitor->id)->count(),
                'handoffTickets' => DB::table('wa_handoff_tickets')->where('visitor_id', $visitor->id)->count(),
            ];

            // Hand-off codes of this visitor go with them; the foreign keys of everything else cascade (sessions, conversations and all
            // that hangs on them) or null out (a linked WhatsApp chat).
            DB::table('wa_handoff_tickets')->where('visitor_id', $visitor->id)->delete();
            $visitor->delete();

            return $counts;
        });

        if ($counts === null) {
            return new ErasureReport(false);
        }

        if ($sessionIds !== []) {
            VisitorSessionsEnded::dispatch($sessionIds, 'erased');
        }

        $this->audit->record('privacy.visitor.erased', null, ['visitor' => $visitor->ulid, ...$counts, 'files' => $attachments->count() * 2], $actor);

        return new ErasureReport(true, $counts);
    }

    /**
     * @param  iterable<Attachment>  $attachments
     */
    private function deleteFiles(iterable $attachments): void
    {
        foreach ($attachments as $attachment) {
            $disk = Storage::disk($attachment->disk);

            foreach (array_values(array_filter([$attachment->path, $attachment->thumb_path])) as $path) {
                $disk->delete($path);

                if ($disk->exists($path)) {
                    throw new RuntimeException('A stored file could not be deleted; nothing else was removed. Run the erasure again.');
                }
            }
        }
    }
}
