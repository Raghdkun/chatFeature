<?php

namespace App\Domain\Privacy\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

/**
 * `GET /api/v1/visitors/{ulid}/export`: everything the application holds about one visitor, as one JSON document (a data-subject access
 * request): the identity as stored, every session, every conversation with its messages, attachments (metadata and a short-lived signed
 * URL for each file), rating, timeline and offline tickets, and counts of the WhatsApp records linked to them. Administrators only
 * (`VisitorPolicy`, asked again here), recorded in the audit log (ids and counts, never the content).
 *
 * Streamed: a visitor with a long history is written conversation by conversation, so memory stays flat. Staff appear by their public
 * label only (never an e-mail address or an internal id); the network fingerprint (`network_hash`) and the token hash are not exported (they
 * identify no one outside the system and cannot be turned back into anything).
 */
final class ExportVisitorData
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly AttachmentUrls $urls,
    ) {}

    /**
     * Authorises, records the export and returns the writer of the document.
     *
     * @return Closure(): void
     */
    public function handle(Visitor $visitor, User $actor): Closure
    {
        Gate::forUser($actor)->authorize('export', $visitor);

        $conversations = Conversation::query()->where('visitor_id', $visitor->id)->count();
        $messages = (int) DB::table('messages')->whereIn('conversation_id', Conversation::query()->where('visitor_id', $visitor->id)->select('id'))->count();

        $this->audit->record('privacy.visitor.exported', null, ['visitor' => $visitor->ulid, 'conversations' => $conversations, 'messages' => $messages], $actor);

        return function () use ($visitor): void {
            echo '{"exportedAt":'.json_encode(Timestamps::iso(now())).',"subject":'.$this->json($this->subject($visitor));
            echo ',"sessions":'.$this->json($this->sessions($visitor));
            echo ',"conversations":[';

            $first = true;

            foreach (Conversation::query()->where('visitor_id', $visitor->id)->with(['category', 'widget', 'assignedAgent', 'rating', 'events'])->orderBy('id')->lazyById(200) as $conversation) {
                echo ($first ? '' : ',').$this->json($this->conversation($conversation));
                $first = false;
            }

            echo '],"whatsapp":'.$this->json($this->whatsapp($visitor)).'}';
        };
    }

    /**
     * @return array<string, mixed>
     */
    private function subject(Visitor $visitor): array
    {
        return [
            'type' => 'visitor',
            'ulid' => $visitor->ulid,
            'verified' => $visitor->verified,
            'externalId' => $visitor->external_id,
            'name' => $visitor->name,
            'email' => $visitor->email,
            'phone' => $visitor->phone,
            'meta' => $visitor->meta,
            'widget' => $visitor->widget->public_key,
            'firstSeenAt' => Timestamps::iso($visitor->first_seen_at),
            'lastSeenAt' => Timestamps::iso($visitor->last_seen_at),
            'createdAt' => Timestamps::iso($visitor->created_at),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function sessions(Visitor $visitor): array
    {
        return array_values($visitor->sessions()->orderBy('id')->get()->map(fn ($session): array => [
            'ulid' => $session->ulid,
            'createdAt' => Timestamps::iso($session->created_at),
            'expiresAt' => Timestamps::iso($session->expires_at),
            'revokedAt' => Timestamps::iso($session->revoked_at),
            'lastUsedAt' => Timestamps::iso($session->last_used_at),
            'pageUrl' => $session->page_url,
            'pageTitle' => $session->page_title,
            'referrer' => $session->referrer,
            'userAgent' => $session->user_agent,
            'locale' => $session->locale,
        ])->all());
    }

    /**
     * @return array<string, mixed>
     */
    private function conversation(Conversation $conversation): array
    {
        $messages = [];
        $attachments = Attachment::query()->where('conversation_id', $conversation->id)->orderBy('position')->orderBy('id')->get()->groupBy('message_id');

        foreach (Message::query()->where('conversation_id', $conversation->id)->with('senderUser')->orderBy('seq')->lazyById(500) as $message) {
            $messages[] = [
                'ulid' => $message->ulid,
                'seq' => $message->seq,
                'sender' => $message->sender_type->value,
                'agent' => $message->senderUser?->public_label,
                'type' => $message->type->value,
                'body' => $message->body,
                'createdAt' => Timestamps::iso($message->created_at),
                'deliveredAt' => Timestamps::iso($message->delivered_at),
                'seenAt' => Timestamps::iso($message->seen_at),
                'attachments' => $this->attachments($attachments->get($message->id, collect())),
            ];
        }

        return [
            'ulid' => $conversation->ulid,
            'ticketNo' => $conversation->ticket_no,
            'type' => $conversation->type->value,
            'status' => $conversation->status->value,
            'widget' => $conversation->widget->name,
            'category' => $conversation->category?->name,
            'agent' => $conversation->assignedAgent?->public_label,
            'createdAt' => Timestamps::iso($conversation->created_at),
            'queuedAt' => Timestamps::iso($conversation->queued_at),
            'claimedAt' => Timestamps::iso($conversation->claimed_at),
            'endedAt' => Timestamps::iso($conversation->ended_at),
            'closedAt' => Timestamps::iso($conversation->closed_at),
            'endedBy' => $conversation->ended_by?->value,
            'closeReason' => $conversation->close_reason?->value,
            'rating' => $conversation->rating === null ? null : ['score' => $conversation->rating->score, 'comment' => $conversation->rating->comment, 'createdAt' => Timestamps::iso($conversation->rating->created_at)],
            'messages' => $messages,
            'unsentAttachments' => $this->attachments($attachments->get(null, collect())),
            'events' => $conversation->events->map(fn ($event): array => ['type' => $event->type, 'actor' => $event->actor_type, 'at' => Timestamps::iso($event->created_at), 'payload' => $event->payload])->all(),
        ];
    }

    /**
     * @param  iterable<Attachment>  $attachments
     * @return list<array<string, mixed>>
     */
    private function attachments(iterable $attachments): array
    {
        $out = [];

        foreach ($attachments as $attachment) {
            $out[] = [
                'ulid' => $attachment->ulid,
                'name' => $attachment->original_name,
                'mime' => $attachment->mime,
                'size' => $attachment->size,
                'width' => $attachment->width,
                'height' => $attachment->height,
                'uploadedBy' => $attachment->uploader_type->value,
                'createdAt' => Timestamps::iso($attachment->created_at),
                'url' => $this->urls->url($attachment),
            ];
        }

        return $out;
    }

    /**
     * The WhatsApp records that point at this visitor are a separate record kept for administrators (their own list, export and erasure).
     *
     * @return array<string, int>
     */
    private function whatsapp(Visitor $visitor): array
    {
        return [
            'linkedChats' => DB::table('wa_chats')->where('visitor_id', $visitor->id)->count(),
            'handoffTickets' => DB::table('wa_handoff_tickets')->where('visitor_id', $visitor->id)->count(),
        ];
    }

    private function json(mixed $value): string
    {
        return (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION);
    }
}
