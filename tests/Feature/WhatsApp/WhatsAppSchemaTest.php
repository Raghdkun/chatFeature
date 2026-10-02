<?php

namespace Tests\Feature\WhatsApp;

use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/**
 * The P6 tables: shape, the unique constraints the WhatsApp actions rely on, and what each foreign key does when its parent goes.
 * (A MySQL run of the same migrations, with the FULLTEXT index and the binary collations, is part of the phase gate.)
 */
class WhatsAppSchemaTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array<string, list<string>>
     */
    private static function expectedColumns(): array
    {
        return [
            'whatsapp_sessions' => [
                'id', 'ulid', 'workspace_id', 'name', 'name_key', 'openwa_session_id', 'openwa_webhook_id', 'engine', 'status', 'phone_e164', 'push_name',
                'webhook_secret_encrypted', 'webhook_registered_at', 'last_qr', 'last_qr_at', 'ready_at', 'last_event_ms', 'last_error', 'settings', 'created_at', 'updated_at', 'deleted_at',
            ],
            'wa_handoff_tickets' => [
                'id', 'ulid', 'widget_id', 'visitor_id', 'category_id', 'session_id', 'network_hash', 'code', 'expires_at', 'consumed_at', 'wa_chat_id', 'created_at', 'updated_at',
            ],
            'wa_chats' => [
                'id', 'ulid', 'workspace_id', 'session_id', 'chat_id', 'phone_e164', 'push_name', 'is_group', 'status', 'widget_id', 'visitor_id', 'category_id',
                'handoff_ticket_id', 'last_inbound_at', 'last_message_at', 'last_message_preview', 'unread_by_admin', 'inbound_initiated', 'created_at', 'updated_at',
            ],
            'wa_messages' => [
                'id', 'ulid', 'wa_chat_id', 'direction', 'wa_message_id', 'client_msg_id', 'type', 'body', 'media_path', 'media_mime', 'media_filename', 'media_size',
                'sent_by_user_id', 'status', 'error', 'announced_at', 'wa_timestamp', 'raw', 'created_at', 'updated_at',
            ],
            'wa_webhook_deliveries' => ['id', 'session_id', 'idempotency_key', 'delivery_id', 'event', 'outcome', 'received_at', 'processed_at', 'error', 'body', 'replays'],
            // Added by the backend track (migration 2026_11_26): the daily send counter.
            'wa_send_counters' => ['session_id', 'day', 'count'],
        ];
    }

    /**
     * @return list<string> one entry per index of the table: its columns joined by a comma
     */
    private function indexes(string $table): array
    {
        return array_map(static fn (array $index): string => implode(',', $index['columns']), Schema::getIndexes($table));
    }

    private function assertUniqueViolation(callable $write, string $message): void
    {
        try {
            $write();
            $this->fail($message);
        } catch (UniqueConstraintViolationException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_every_table_has_exactly_the_documented_columns(): void
    {
        foreach (self::expectedColumns() as $table => $columns) {
            $this->assertTrue(Schema::hasTable($table), $table);
            $this->assertEqualsCanonicalizing($columns, Schema::getColumnListing($table), "columns of {$table}");
        }

        $this->assertTrue(Schema::hasColumn('widgets', 'whatsapp_session_id'));
    }

    public function test_the_migrations_roll_back_cleanly_and_run_again(): void
    {
        // Back to the state before the first WhatsApp migration, whatever later phases (P7: analytics, ...) added after it.
        $steps = DB::table('migrations')->where('migration', '>=', '2026_11_25_000100_create_whatsapp_sessions_table')->count();
        $this->assertGreaterThanOrEqual(7, $steps);
        $this->artisan('migrate:rollback', ['--step' => $steps, '--force' => true])->assertSuccessful();

        foreach (array_keys(self::expectedColumns()) as $table) {
            $this->assertFalse(Schema::hasTable($table), "{$table} should be gone after the rollback");
        }

        $this->assertFalse(Schema::hasColumn('widgets', 'whatsapp_session_id'));
        $this->assertTrue(Schema::hasTable('conversations'), 'earlier phases are untouched');

        $this->artisan('migrate', ['--force' => true])->assertSuccessful();

        foreach (self::expectedColumns() as $table => $columns) {
            $this->assertEqualsCanonicalizing($columns, Schema::getColumnListing($table), $table);
        }

        $this->assertTrue(Schema::hasColumn('widgets', 'whatsapp_session_id'));
    }

    public function test_the_inbox_transcript_and_lookups_have_their_indexes(): void
    {
        $expected = [
            'whatsapp_sessions' => ['ulid', 'status', 'openwa_session_id', 'name_key'],
            'wa_chats' => ['ulid', 'session_id,chat_id', 'status,last_message_at', 'session_id,status,last_message_at', 'phone_e164', 'handoff_ticket_id'],
            'wa_handoff_tickets' => ['ulid', 'code', 'expires_at', 'session_id,expires_at', 'widget_id,network_hash'],
            'wa_messages' => ['ulid', 'wa_chat_id,wa_message_id', 'wa_chat_id,id', 'wa_message_id', 'wa_chat_id,client_msg_id', 'status,created_at'],
            'wa_webhook_deliveries' => ['session_id,idempotency_key', 'received_at', 'outcome,received_at'],
        ];

        foreach ($expected as $table => $indexes) {
            $actual = $this->indexes($table);

            foreach ($indexes as $columns) {
                $this->assertContains($columns, $actual, "{$table} needs an index on ({$columns}); has: ".implode(' | ', $actual));
            }
        }
    }

    public function test_the_message_body_fulltext_index_exists_on_mysql_only(): void
    {
        $fullText = array_filter(Schema::getIndexes('wa_messages'), static fn (array $index): bool => ($index['type'] ?? '') === 'fulltext');

        $this->assertCount(in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true) ? 1 : 0, $fullText);
    }

    public function test_a_session_name_is_unique_among_live_sessions_and_a_deleted_session_frees_it(): void
    {
        $first = WhatsAppSession::factory()->create(['name' => 'support-main']);

        $this->assertUniqueViolation(fn () => WhatsAppSession::factory()->create(['name' => 'support-main']), 'a live duplicate name');

        $first->delete();
        $second = WhatsAppSession::factory()->create(['name' => 'support-main']);

        $this->assertSame(2, WhatsAppSession::withTrashed()->where('name', 'support-main')->count());
        $this->assertUniqueViolation(fn () => $first->restore(), 'a deleted session cannot come back while its name is taken');

        $second->delete();
        $first->restore();
        $this->assertNull($first->fresh()?->deleted_at);
    }

    public function test_the_openwa_session_id_is_unique_but_many_sessions_may_have_none(): void
    {
        WhatsAppSession::factory()->count(3)->create(['openwa_session_id' => null]);
        WhatsAppSession::factory()->create(['openwa_session_id' => 'abc']);

        $this->assertUniqueViolation(fn () => WhatsAppSession::factory()->create(['openwa_session_id' => 'abc']), 'the same OpenWA id twice');
    }

    public function test_a_chat_id_is_unique_per_session_not_across_sessions(): void
    {
        $session = WhatsAppSession::factory()->create();
        $other = WhatsAppSession::factory()->create();

        WaChat::factory()->create(['session_id' => $session->id, 'chat_id' => '4915100000001@c.us']);
        WaChat::factory()->create(['session_id' => $other->id, 'chat_id' => '4915100000001@c.us']);

        $this->assertUniqueViolation(fn () => WaChat::factory()->create(['session_id' => $session->id, 'chat_id' => '4915100000001@c.us']), 'one chat twice in a session');
    }

    public function test_a_whatsapp_message_id_is_unique_per_chat_and_missing_ids_never_collide(): void
    {
        $chat = WaChat::factory()->create();
        $other = WaChat::factory()->create();

        WaMessage::factory()->count(3)->pending()->create(['wa_chat_id' => $chat->id]);
        WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'wa_message_id' => 'false_1@c.us_ABC']);
        WaMessage::factory()->create(['wa_chat_id' => $other->id, 'wa_message_id' => 'false_1@c.us_ABC']);

        $this->assertUniqueViolation(fn () => WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'wa_message_id' => 'false_1@c.us_ABC']), 'a message twice in a chat');
    }

    public function test_a_handoff_code_is_unique(): void
    {
        WaHandoffTicket::factory()->create(['code' => 'K7M2QX3P']);

        $this->assertUniqueViolation(fn () => WaHandoffTicket::factory()->create(['code' => 'K7M2QX3P']), 'a code twice');
    }

    public function test_a_webhook_delivery_key_is_unique_per_session(): void
    {
        $session = WhatsAppSession::factory()->create();
        $other = WhatsAppSession::factory()->create();

        WaWebhookDelivery::factory()->create(['session_id' => $session->id, 'idempotency_key' => 'msg_a_b_c']);
        WaWebhookDelivery::factory()->create(['session_id' => $other->id, 'idempotency_key' => 'msg_a_b_c']);

        $this->assertUniqueViolation(fn () => WaWebhookDelivery::factory()->create(['session_id' => $session->id, 'idempotency_key' => 'msg_a_b_c']), 'a delivery twice');
    }

    public function test_deleting_a_session_for_good_takes_its_records_with_it_and_unlinks_its_widgets(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $widget = Widget::factory()->withWhatsAppSession($session)->create();
        $chat = WaChat::factory()->linked($widget)->create(['session_id' => $session->id]);
        $message = WaMessage::factory()->create(['wa_chat_id' => $chat->id]);
        $delivery = WaWebhookDelivery::factory()->create(['session_id' => $session->id]);

        $session->forceDelete();

        $this->assertNull(WaChat::query()->find($chat->id));
        $this->assertNull(WaMessage::query()->find($message->id));
        $this->assertSame(0, WaHandoffTicket::query()->where('session_id', $session->id)->count());
        $this->assertNull(WaWebhookDelivery::query()->find($delivery->id));
        $this->assertNull($widget->fresh()?->whatsapp_session_id, 'the widget stays, without a number');
    }

    public function test_a_soft_deleted_session_keeps_its_history_and_no_longer_counts_as_a_widgets_session(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $widget = Widget::factory()->withWhatsAppSession($session)->create();
        $chat = WaChat::factory()->create(['session_id' => $session->id]);
        WaMessage::factory()->count(2)->create(['wa_chat_id' => $chat->id]);

        $session->delete();

        $this->assertSame(2, WaMessage::query()->where('wa_chat_id', $chat->id)->count());
        $this->assertTrue($chat->fresh()?->session->is($session), 'the inbox still names the session of a recorded chat');
        $this->assertNull($widget->fresh()?->whatsappSession, 'but a widget has no session any more');
    }

    public function test_a_recorded_chat_survives_the_deletion_of_what_it_was_linked_to(): void
    {
        $category = Category::factory()->create();
        $widget = Widget::factory()->create();
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id]);
        $chat = WaChat::factory()->linked($widget, $visitor, $category)->create();
        $ticket = WaHandoffTicket::query()->findOrFail($chat->handoff_ticket_id);

        $category->forceDelete();
        $visitor->delete();

        $chat->refresh();
        $ticket->refresh();
        $this->assertNull($chat->category_id);
        $this->assertNull($chat->visitor_id);
        $this->assertNull($ticket->category_id);
        $this->assertNull($ticket->visitor_id);
        $this->assertSame($widget->id, $chat->widget_id);

        $widget->forceDelete();

        $this->assertNull($chat->fresh()?->widget_id);
        $this->assertNull(WaHandoffTicket::query()->find($ticket->id), 'a ticket belongs to its widget');
        $this->assertNull($chat->fresh()?->handoff_ticket_id);
    }

    public function test_a_chat_and_its_ticket_forget_each_other_when_one_goes(): void
    {
        $chat = WaChat::factory()->linked()->create();
        $ticket = WaHandoffTicket::query()->findOrFail($chat->handoff_ticket_id);
        $this->assertSame($chat->id, $ticket->wa_chat_id);

        $ticket->delete();
        $this->assertNull($chat->fresh()?->handoff_ticket_id);

        $other = WaChat::factory()->linked()->create();
        $otherTicket = WaHandoffTicket::query()->findOrFail($other->handoff_ticket_id);
        $other->delete();

        $this->assertNull($otherTicket->fresh()?->wa_chat_id);
    }

    public function test_a_reply_outlives_the_administrator_who_wrote_it(): void
    {
        $admin = User::factory()->admin()->create();
        $message = WaMessage::factory()->outbound($admin)->create();

        $admin->delete();

        $this->assertNull($message->fresh()?->sent_by_user_id);
        $this->assertNotNull($message->fresh());
    }

    public function test_deleting_a_chat_deletes_its_messages(): void
    {
        $chat = WaChat::factory()->create();
        WaMessage::factory()->count(3)->create(['wa_chat_id' => $chat->id]);

        $chat->delete();

        $this->assertSame(0, WaMessage::query()->count());
    }
}
