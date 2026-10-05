<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Chat\AttachmentData;
use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\MessageData;
use App\Data\Chat\TransferTargetsData;
use App\Domain\Chat\Services\ConversationExporter;
use App\Support\ApiDocs\Doc;
use App\Support\ApiDocs\ExampleValues;

/** The staff inbox: conversations, their messages, attachments, receipts and typing. */
final class ConversationEntries implements EntryList
{
    public static function docs(): array
    {
        $exportRow = array_fill_keys(ConversationExporter::COLUMNS, '');
        $csvHeader = implode(',', ConversationExporter::COLUMNS);
        $csvRow = implode(',', ['X4BWQW', ExampleValues::CONVERSATION, 'live', 'closed', 'Main website', 'Billing', 'Sam Rivera', 'Ada Lovelace', 'ada@example.com', 'false', '2026-09-30T12:00:00.000Z', '2026-09-30T12:00:18.000Z', '2026-09-30T12:12:09.000Z', '2026-09-30T12:13:00.000Z', 'agent', 'rated', '14', '5']);

        return [
            Doc::route('api.conversations.index')
                ->in('Conversations')
                ->title('List conversations')
                ->about("Newest first, cursor-paged. Visibility is decided by the server: an agent sees the chats assigned to them, the open offers while a chat is queued and queued offline tickets of the categories they serve; an administrator sees everything. WhatsApp chats are not conversations and never appear here.\n\nFilter by `status` (comma-separated), `category`, `widget`, `agent`, `type`, `q` and the creation time (`from`, `to`). `updated_after` is the incremental sync a client uses after a reconnect: ask for everything changed since the newest `updated` instant you hold and merge by `ulid`.")
                ->paged(ConversationStaffData::class, 'A page of conversations.')
                ->without('format')
                ->errors(['validation_failed' => 'A filter is invalid (an unknown status, a malformed date, a hand-made cursor).']),

            Doc::route('api.conversations.queue')
                ->in('Conversations')
                ->title('List the waiting chats')
                ->about('Queued chats the caller can accept right now: their open offers and the offline tickets of their categories (an administrator sees all), oldest first, at most 200. Use `queueExpiresAt` to count down a live chat\'s remaining wait.')
                ->list(ConversationStaffData::class),

            Doc::route('api.conversations.export')
                ->in('Conversations')
                ->title('Export conversations')
                ->about("Streams the filtered range as CSV (default) or JSON, in chunks of 500 (flat memory; PHP's time limit is lifted for the stream) with `Content-Disposition: attachment`. CSV cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with a quote. The export is recorded in the audit log (`conversations.exported`) because it hands out personal data in bulk.\n\nCSV columns (also the keys of each JSON row, which is wrapped in `{ \"data\": [...] }`): `".implode('`, `', ConversationExporter::COLUMNS).'`.')
                ->raw(200, 'text/csv; charset=utf-8', $csvHeader."\n".$csvRow."\n", 'A CSV file (or, with `format=json`, `{ "data": [ { ...one object per conversation } ] }`).', ['Content-Disposition' => 'attachment; filename="conversations-20260930-120000.csv"', 'Cache-Control' => 'no-store'])
                ->without('limit', 'cursor')
                ->errors(['validation_failed' => 'A filter is invalid.']),

            Doc::route('api.conversations.show')
                ->in('Conversations')
                ->title('Show a conversation')
                ->about('A conversation the caller may see: the assigned agent or an administrator, or an agent holding an open offer while the chat is queued. Anything else is `403 forbidden`.')
                ->item(ConversationStaffData::class)
                ->errors(['forbidden' => 'The caller may not see this conversation.']),

            Doc::route('api.conversations.transfer-targets')
                ->in('Conversations')
                ->title('List transfer targets')
                ->about("Who an active live chat can be handed to right now: active agents who serve the chat's category (not the caller, not the agent who has it) with their effective presence and load, and the other categories of the chat's widget that currently have a reachable agent. `reachable` is exactly what `POST .../transfer` accepts for that colleague. No e-mail addresses.")
                ->item(TransferTargetsData::class)
                ->errors(['forbidden' => 'The caller may not see this conversation.', 'conversation_not_live', 'conversation_not_active']),

            Doc::route('api.conversations.claim')
                ->in('Conversations')
                ->title('Accept a chat')
                ->about("The atomic first-accept: one guarded SQL update decides the winner, everyone else gets `409 already_claimed` with the winner's name in `error.details.by`. Needs category eligibility and fewer than `max_concurrent_chats` live chats (offline tickets take no slot). Accepting a chat that is already yours (a second tab, a double tap) is `200` with the conversation: no event, no second \"joined\" line, even at capacity.\n\nAdministrators who take chats may accept any queued chat.")
                ->item(ConversationStaffData::class)
                ->errors([
                    'already_claimed',
                    'conversation_not_queued' => 'The chat is gone: cancelled by the visitor, missed, closed.',
                    'at_capacity',
                    'forbidden' => 'Not an active agent, no open offer for this chat, or the agent does not serve its category.',
                ]),

            Doc::route('api.conversations.end')
                ->in('Conversations')
                ->title('End a chat')
                ->about('The assigned agent or an administrator ends an active live chat. The visitor gets the rating prompt (`ratingRequested: true`) unless the widget has rating switched off: then the chat goes straight to `closed` (reason `skipped`) after the `ended` event.')
                ->item(ConversationStaffData::class)
                ->errors(['forbidden' => 'Not the assigned agent or an administrator.', 'conversation_not_active']),

            Doc::route('api.conversations.close')
                ->in('Conversations')
                ->title('Close a conversation')
                ->about('An agent resolves their claimed **offline ticket**; an administrator closes any unfinished conversation (queued, active or ended). The result is `closed` (reason `system`) with no rating prompt.')
                ->item(ConversationStaffData::class)
                ->errors(['forbidden' => 'Not allowed to close this conversation.', 'conversation_not_open']),

            Doc::route('api.conversations.transfer')
                ->in('Conversations')
                ->title('Transfer a chat')
                ->about("Hands an active chat to a colleague (`agent_id`) or a topic (`category`). It returns to `queued` with the assignee cleared and the history kept. A category goes through the routing waves again (the agent who let go is not offered it); a colleague is the only one offered it and accepts it like any offer.\n\nA **live** chat is only handed to somebody who can take it now, otherwise `409 no_agents` with `details.target` and `details.reason` and the agent keeps the chat. See `GET .../transfer-targets` to check first.")
                ->item(ConversationStaffData::class)
                ->errors([
                    'forbidden' => 'Not the assigned agent or an administrator.',
                    'conversation_not_active',
                    'no_agents' => 'Nobody can take it: `details.target` is `agent` (`reason`: `offline`, `at_capacity`) or `category` (`reason`: `no_reachable_agent`).',
                    'validation_failed' => 'Neither or both of `agent_id` and `category`, or an unknown target.',
                ]),

            Doc::route('api.conversations.messages.index')
                ->in('Messages & attachments')
                ->title('List messages')
                ->about("Messages after `after_seq`, ascending by `seq`, at most `limit`. `meta.next_cursor` is the `after_seq` of the next page and `null` at the end. Staff payloads carry the sender's staff id (`sender.id`).\n\n**Gap sync.** Every client keeps the highest `seq` it holds per conversation and, after a reconnect, when the app returns to the foreground or when it sees a gap, calls this with `after_seq` set to it: no duplicates, no holes. Realtime events are an optimisation, never the only source.")
                ->paged(MessageData::class, 'A page of messages.')
                ->errors(['forbidden' => 'The caller may not see this conversation.']),

            Doc::route('api.conversations.messages.store')
                ->in('Messages & attachments')
                ->title('Send a message')
                ->about("Only the assigned agent or an administrator, and only while the chat is `active`. A reply on an **offline ticket** is also e-mailed (a queued mail) to the visitor's address.\n\n**Idempotent.** Send a `client_msg_id` (a ULID you make up): a repeat answers `200` with the original message instead of storing a second one, also after the chat ended, so a flaky connection can retry blindly.")
                ->created(MessageData::class, 'The message was stored.')
                ->item(MessageData::class, 200, 'A repeat of a `client_msg_id` already stored: the original message.')
                ->errors(['forbidden' => 'Not the assigned agent or an administrator.', 'conversation_not_active']),

            Doc::route('api.conversations.attachments.store')
                ->in('Messages & attachments')
                ->title('Upload an image')
                ->about("Multipart upload of one image into an active chat, then reference its `ulid` in the next message (`attachments`). The image is judged by content, decoded and encoded again (so EXIF and anything hidden in it do not survive), a 320 px thumbnail is made and the files go to a private disk behind signed URLs. Unreferenced uploads are deleted after 24 hours.\n\nA native client builds the multipart body itself: field name `file`, a real file part with its own content type.")
                ->created(AttachmentData::class)
                ->errors([
                    'forbidden' => 'Not the assigned agent or an administrator.',
                    'conversation_not_active',
                    'feature_disabled' => 'The widget switched attachments off.',
                    'attachment_quota_exceeded',
                    'validation_failed' => 'Not a JPEG, PNG, WebP or still GIF by content, an animated GIF, or too large in bytes or pixels. The message is under `details.file`. (At ten unused uploads the oldest unused uploads of the same uploader are dropped to make room.)',
                ]),

            Doc::route('api.conversations.receipts.store')
                ->in('Messages & attachments')
                ->title('Report delivery and read receipts')
                ->about('Only the assigned agent (an administrator looking in does not mark a chat read). It stamps `deliveredAt` / `seenAt` on the visitor\'s messages up to the given numbers (reading implies delivery) and announces `message.delivered` / `message.seen` on the conversation channel; repeating a receipt changes and announces nothing. Batch them: report once per screen, not per message.')
                ->noContent(204, 'Recorded.')
                ->errors(['forbidden' => 'Not the assigned agent.']),

            Doc::route('api.conversations.typing.store')
                ->in('Messages & attachments')
                ->title('Send a typing indicator')
                ->about('The REST fallback of the `client-typing` websocket whisper (clients normally whisper). Validated and authorised, then published as the realtime `typing` event; nothing is stored and it never counts as activity for the idle timer.')
                ->noContent(204, 'Published.')
                ->errors(['forbidden' => 'Not the assigned agent.', 'conversation_not_active']),
        ];
    }
}
