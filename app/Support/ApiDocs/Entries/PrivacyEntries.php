<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Privacy\RetentionData;
use App\Data\Privacy\VisitorErasureData;
use App\Support\ApiDocs\Doc;

/** Data-subject requests about one visitor and the retention of closed conversations (administrators only). */
final class PrivacyEntries implements EntryList
{
    public static function docs(): array
    {
        $example = json_encode(['exportedAt' => '2026-10-02T09:00:00.000Z', 'subject' => ['type' => 'visitor', 'ulid' => '01j9...', 'name' => 'Ada Lovelace', 'email' => 'ada@example.com'], 'sessions' => [], 'conversations' => [], 'whatsapp' => ['linkedChats' => 0, 'handoffTickets' => 0]], JSON_THROW_ON_ERROR);

        return [
            Doc::route('api.visitors.export')
                ->in('Privacy')
                ->title('Export everything held about a visitor')
                ->about('A data-subject access request. Streams one JSON document: the identity as stored, every session, every conversation with its messages, attachments (metadata and a short-lived signed URL each), rating and timeline (offline tickets are conversations of type `offline`), and counts of the linked WhatsApp records. Staff appear by their public label only; token and network hashes are not exported. Recorded in the audit log (`privacy.visitor.exported`, ids and counts only). Administrators only.')
                ->raw(200, 'application/json; charset=utf-8', $example, 'The visitor document.', ['Content-Disposition' => 'attachment; filename="visitor-01j9....json"', 'Cache-Control' => 'no-store'])
                ->errors(['not_found' => 'No visitor has this ulid.']),

            Doc::route('api.visitors.destroy')
                ->in('Privacy')
                ->title('Erase a visitor')
                ->about("Erases one visitor for good: identity, sessions, conversations, messages, attachment files (deleted first), ratings, events, offers and offline tickets; the visitor's websockets are closed; a linked WhatsApp chat is unlinked, not deleted (`DELETE /whatsapp/chats/{ulid}`). **Idempotent**: a visitor that is already gone (or never existed, or a malformed ulid) answers `200` with `erased: false` and changes nothing. Refused while the visitor has a queued or active chat. Audited (`privacy.visitor.erased`) with the ulid and counts, never a name, address or text. Administrators only.")
                ->item(VisitorErasureData::class)
                ->errors(['visitor_has_open_chat' => 'The visitor has a queued or active conversation: end or close it first (`details.openConversations`).']),

            Doc::route('api.privacy.retention.show')
                ->in('Privacy')
                ->title('Show the conversation retention')
                ->about('How many days closed and missed conversations (with their messages, images and ratings) are kept before the daily `chat:prune-conversations` deletes them: `0` keeps them for ever. `minimumDays` is the shortest accepted retention.')
                ->item(RetentionData::class),

            Doc::route('api.privacy.retention.update')
                ->in('Privacy')
                ->title('Change the conversation retention')
                ->about('`0` (keep for ever) or 7 to 3 650 days (a shorter retention is refused: analytics rollups seal a day 3 days after it ends). Audited as `settings.updated`.')
                ->param('days', ['description' => 'Retention in days: 0 keeps closed conversations for ever, otherwise 7 to 3650.', 'example' => 90])
                ->item(RetentionData::class)
                ->errors(['validation_failed' => '`days` is missing, not a whole number, below the minimum (other than 0) or above 3650.']),
        ];
    }
}
