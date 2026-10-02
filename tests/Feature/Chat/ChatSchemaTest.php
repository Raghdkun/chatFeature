<?php

namespace Tests\Feature\Chat;

use App\Models\AgentPresence;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationEvent;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/**
 * The P4 tables: shape, the unique constraints the Chat actions rely on, and what each foreign key does when its parent goes.
 * (A MySQL run of the same migrations is part of the phase gate: `migrate:fresh` + rollback on a scratch database.)
 */
class ChatSchemaTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array<string, list<string>>
     */
    private static function expectedColumns(): array
    {
        return [
            'visitors' => ['id', 'ulid', 'workspace_id', 'widget_id', 'external_id', 'verified', 'name', 'email', 'phone', 'meta', 'first_seen_at', 'last_seen_at', 'created_at', 'updated_at'],
            'visitor_sessions' => ['id', 'ulid', 'visitor_id', 'widget_id', 'token_hash', 'expires_at', 'revoked_at', 'last_used_at', 'page_url', 'page_title', 'referrer', 'user_agent', 'locale', 'network_hash', 'created_at', 'updated_at'],
            'conversations' => [
                'id', 'ulid', 'workspace_id', 'widget_id', 'visitor_id', 'visitor_session_id', 'category_id', 'ticket_no', 'type', 'status', 'assigned_agent_id',
                'last_seq', 'claim_version', 'wave', 'queued_at', 'queue_expires_at', 'claimed_at', 'ended_at', 'closed_at', 'ended_by', 'close_reason',
                'last_activity_at', 'idle_expires_at', 'last_message_at', 'last_message_preview', 'unseen_by_agent', 'unseen_by_visitor',
                'rating_requested', 'rating_window_expires_at', 'created_at', 'updated_at',
            ],
            'conversation_events' => ['id', 'conversation_id', 'type', 'actor_type', 'actor_id', 'payload', 'created_at'],
            'conversation_agent_alerts' => ['id', 'conversation_id', 'user_id', 'wave', 'offered_at', 'expires_at', 'responded_at', 'response'],
            'messages' => ['id', 'ulid', 'conversation_id', 'seq', 'sender_type', 'sender_user_id', 'type', 'body', 'client_msg_id', 'delivered_at', 'seen_at', 'created_at'],
            'attachments' => ['id', 'ulid', 'conversation_id', 'message_id', 'uploader_type', 'uploader_user_id', 'disk', 'path', 'thumb_path', 'mime', 'size', 'width', 'height', 'sha256', 'original_name', 'position', 'created_at'],
            'ratings' => ['id', 'conversation_id', 'score', 'comment', 'created_at'],
            'agent_presence' => ['id', 'user_id', 'status', 'is_manual', 'last_seen_at', 'last_heartbeat_at', 'created_at', 'updated_at'],
        ];
    }

    /**
     * @return list<string> one entry per index of the table: its columns joined by a comma
     */
    private function indexes(string $table): array
    {
        return array_map(
            static fn (array $index): string => implode(',', $index['columns']),
            Schema::getIndexes($table),
        );
    }

    public function test_every_table_has_exactly_the_documented_columns(): void
    {
        foreach (self::expectedColumns() as $table => $columns) {
            $this->assertTrue(Schema::hasTable($table), $table);
            $this->assertEqualsCanonicalizing($columns, Schema::getColumnListing($table), "columns of {$table}");
        }
    }

    public function test_the_migrations_roll_back_cleanly_and_run_again(): void
    {
        // The four chat migrations and every later one (a later phase adds its own): roll back all of them, then run them again.
        $steps = count(array_filter(
            array_map('basename', glob(database_path('migrations/*.php')) ?: []),
            static fn (string $file): bool => strcmp($file, '2026_11_10_000100_create_visitors_tables.php') >= 0,
        ));

        $this->artisan('migrate:rollback', ['--step' => $steps, '--force' => true])->assertSuccessful();

        foreach (array_keys(self::expectedColumns()) as $table) {
            $this->assertFalse(Schema::hasTable($table), "{$table} should be gone after the rollback");
        }

        $this->assertTrue(Schema::hasTable('widgets'), 'earlier phases are untouched');

        $this->artisan('migrate', ['--force' => true])->assertSuccessful();

        foreach (self::expectedColumns() as $table => $columns) {
            $this->assertEqualsCanonicalizing($columns, Schema::getColumnListing($table), $table);
        }
    }

    public function test_the_sweeps_and_lookups_have_their_indexes(): void
    {
        $expected = [
            'conversations' => [
                'status,queued_at', 'assigned_agent_id,status,last_message_at', 'type,status,created_at', 'widget_id,created_at', 'category_id,created_at',
                'status,created_at', 'updated_at', 'visitor_id,type,status', 'visitor_session_id,status', 'status,queue_expires_at', 'status,idle_expires_at',
                'status,rating_window_expires_at', 'ulid', 'ticket_no',
            ],
            'conversation_events' => ['conversation_id,id'],
            'conversation_agent_alerts' => ['conversation_id,user_id', 'user_id,responded_at'],
            'messages' => ['conversation_id,seq', 'conversation_id,client_msg_id', 'ulid'],
            'visitors' => ['widget_id,external_id', 'ulid'],
            'visitor_sessions' => ['token_hash', 'expires_at', 'ulid'],
            'attachments' => ['ulid', 'message_id'],
            'ratings' => ['conversation_id'],
            'agent_presence' => ['user_id'],
        ];

        foreach ($expected as $table => $indexes) {
            $actual = $this->indexes($table);

            foreach ($indexes as $columns) {
                $covered = in_array($columns, $actual, true)
                    || array_filter($actual, static fn (string $index): bool => str_starts_with($index, $columns.',') || $index === $columns) !== [];
                $this->assertTrue($covered, "{$table} needs an index on ({$columns}); has: ".implode(' | ', $actual));
            }
        }
    }

    public function test_the_message_body_fulltext_index_exists_on_mysql_only(): void
    {
        $fullText = array_filter(Schema::getIndexes('messages'), static fn (array $index): bool => ($index['type'] ?? '') === 'fulltext');

        if (in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->assertCount(1, $fullText);
        } else {
            $this->assertCount(0, $fullText);
        }
    }

    public function test_anonymous_visitors_never_collide_but_an_external_id_is_unique_per_widget(): void
    {
        $widget = Widget::factory()->create();
        $other = Widget::factory()->create();

        Visitor::factory()->for($widget)->count(3)->create(['external_id' => null]);
        Visitor::factory()->for($widget)->create(['external_id' => 'user-1']);
        Visitor::factory()->for($other)->create(['external_id' => 'user-1']);

        $this->assertSame(5, Visitor::query()->count());
        $this->expectException(UniqueConstraintViolationException::class);

        Visitor::factory()->for($widget)->create(['external_id' => 'user-1']);
    }

    public function test_a_session_token_hash_is_unique(): void
    {
        $session = VisitorSession::factory()->create();

        $this->expectException(UniqueConstraintViolationException::class);

        VisitorSession::factory()->create(['visitor_id' => $session->visitor_id, 'token_hash' => $session->token_hash]);
    }

    public function test_ticket_numbers_are_unique(): void
    {
        $conversation = Conversation::factory()->create();

        $this->expectException(UniqueConstraintViolationException::class);

        Conversation::factory()->create(['ticket_no' => $conversation->ticket_no]);
    }

    public function test_message_seq_is_unique_per_conversation_but_not_across_conversations(): void
    {
        $first = Conversation::factory()->create();
        $second = Conversation::factory()->create();

        Message::factory()->for($first)->create(['seq' => 1]);
        Message::factory()->for($second)->create(['seq' => 1]);

        $this->expectException(UniqueConstraintViolationException::class);

        Message::factory()->for($first)->create(['seq' => 1]);
    }

    public function test_client_msg_id_makes_sends_idempotent_and_null_never_collides(): void
    {
        $conversation = Conversation::factory()->create();
        $clientMsgId = '01JABCDEFGHJKMNPQRSTVWXYZ0';

        Message::factory()->for($conversation)->count(3)->create(['client_msg_id' => null]);
        Message::factory()->for($conversation)->create(['client_msg_id' => $clientMsgId]);
        Message::factory()->for(Conversation::factory())->create(['client_msg_id' => $clientMsgId]);

        $this->assertSame(5, Message::query()->count());
        $this->expectException(UniqueConstraintViolationException::class);

        Message::factory()->for($conversation)->create(['client_msg_id' => $clientMsgId]);
    }

    public function test_an_agent_is_offered_a_conversation_only_once(): void
    {
        $offer = ConversationOffer::factory()->create();

        $this->expectException(UniqueConstraintViolationException::class);

        ConversationOffer::factory()->create(['conversation_id' => $offer->conversation_id, 'user_id' => $offer->user_id]);
    }

    public function test_a_conversation_is_rated_once_and_a_user_has_one_presence_row(): void
    {
        $rating = Rating::factory()->create();
        $presence = AgentPresence::factory()->create();

        try {
            Rating::factory()->create(['conversation_id' => $rating->conversation_id]);
            $this->fail('A second rating must be refused.');
        } catch (UniqueConstraintViolationException) {
            $this->assertSame(1, Rating::query()->count());
        }

        $this->expectException(UniqueConstraintViolationException::class);

        AgentPresence::factory()->create(['user_id' => $presence->user_id]);
    }

    public function test_deleting_a_conversation_removes_everything_that_hangs_off_it(): void
    {
        $conversation = Conversation::factory()->closed()->create();
        $message = Message::factory()->for($conversation)->create();
        Attachment::factory()->create(['conversation_id' => $conversation->id, 'message_id' => $message->id]);
        ConversationEvent::factory()->create(['conversation_id' => $conversation->id]);
        ConversationOffer::factory()->create(['conversation_id' => $conversation->id]);
        Rating::factory()->create(['conversation_id' => $conversation->id]);

        $conversation->delete();

        foreach (['messages', 'attachments', 'conversation_events', 'conversation_agent_alerts', 'ratings'] as $table) {
            $this->assertSame(0, DB::table($table)->count(), $table);
        }
    }

    public function test_the_attachments_of_a_message_come_back_by_position_then_by_age(): void
    {
        $message = Message::factory()->create();
        $make = fn (int $position) => Attachment::factory()->create(['conversation_id' => $message->conversation_id, 'message_id' => $message->id, 'position' => $position]);
        $third = $make(2);
        $first = $make(0);
        $second = $make(1);
        $tieOlder = $make(1);
        $unnumbered = Attachment::factory()->create(['conversation_id' => $message->conversation_id, 'message_id' => $message->id]);

        $this->assertSame(0, $unnumbered->fresh()->position, 'the column defaults to 0 for rows written without one');
        $this->assertSame(
            [$first->id, $unnumbered->id, $second->id, $tieOlder->id, $third->id],
            $message->fresh()->attachments->pluck('id')->all(),
        );
    }

    public function test_deleting_a_message_keeps_its_attachments_unlinked(): void
    {
        $message = Message::factory()->create();
        $attachment = Attachment::factory()->create(['conversation_id' => $message->conversation_id, 'message_id' => $message->id]);

        $message->delete();

        $this->assertNull($attachment->fresh()?->message_id);
    }

    public function test_deleting_a_category_keeps_the_conversation_and_clears_its_category(): void
    {
        $category = Category::factory()->create();
        $conversation = Conversation::factory()->forCategory($category)->create();

        $category->forceDelete();

        $this->assertNull($conversation->fresh()?->category_id);
    }

    public function test_deleting_a_user_keeps_conversations_and_messages_but_drops_presence_and_offers(): void
    {
        $agent = User::factory()->create();
        $conversation = Conversation::factory()->active($agent)->create();
        $message = Message::factory()->for($conversation)->fromAgent($agent)->create();
        AgentPresence::factory()->create(['user_id' => $agent->id]);
        ConversationOffer::factory()->create(['user_id' => $agent->id]);

        $agent->delete();

        $this->assertNull($conversation->fresh()?->assigned_agent_id);
        $this->assertNull($message->fresh()?->sender_user_id);
        $this->assertSame(0, AgentPresence::query()->count());
        $this->assertSame(0, ConversationOffer::query()->count());
    }

    public function test_deleting_a_visitor_session_keeps_the_conversation(): void
    {
        $conversation = Conversation::factory()->create();

        VisitorSession::query()->whereKey($conversation->visitor_session_id)->delete();

        $this->assertNotNull($conversation->fresh());
        $this->assertNull($conversation->fresh()?->visitor_session_id);
    }

    public function test_deleting_a_visitor_removes_their_sessions_and_conversations(): void
    {
        $conversation = Conversation::factory()->create();

        Visitor::query()->whereKey($conversation->visitor_id)->delete();

        $this->assertSame(0, Conversation::query()->count());
        $this->assertSame(0, VisitorSession::query()->count());
    }

    public function test_purging_a_widget_removes_its_visitors_sessions_and_conversations(): void
    {
        $conversation = Conversation::factory()->create();

        Widget::query()->whereKey($conversation->widget_id)->first()?->forceDelete();

        $this->assertSame(0, Visitor::query()->count());
        $this->assertSame(0, VisitorSession::query()->count());
        $this->assertSame(0, Conversation::query()->count());
    }

    public function test_foreign_keys_are_enforced(): void
    {
        $this->expectException(QueryException::class);

        DB::table('messages')->insert(['ulid' => '01JABCDEFGHJKMNPQRSTVWXYZ0', 'conversation_id' => 999_999, 'seq' => 1, 'sender_type' => 'visitor', 'type' => 'text']);
    }

    public function test_new_conversations_get_the_documented_column_defaults(): void
    {
        $conversation = Conversation::factory()->create();
        $row = DB::table('conversations')->where('id', $conversation->id)->first();

        $this->assertNotNull($row);
        $this->assertSame('live', $row->type);
        $this->assertSame('queued', $row->status);
        $this->assertSame(0, (int) $row->last_seq);
        $this->assertSame(0, (int) $row->claim_version);
        $this->assertSame(0, (int) $row->wave);
        $this->assertSame(0, (int) $row->unseen_by_agent);
        $this->assertSame(0, (int) $row->unseen_by_visitor);
        $this->assertSame(0, (int) $row->rating_requested);
    }
}
