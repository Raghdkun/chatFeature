<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What the WhatsApp backend (P6, track 6A) needs on top of the spine's schema:
 *
 * - `wa_messages.client_msg_id` (ULID, like `messages.client_msg_id` of the live chat): a reply the dashboard repeats (a double click,
 *   a retry after a lost answer) is one message. UNIQUE with the chat; NULLs never collide (inbound rows have none).
 * - `wa_messages (status, created_at)`: the reconciliation looks for replies that have been `pending` for a long time.
 * - `wa_send_counters`: how many messages a session was allowed to send on one UTC day, the daily cap (`whatsapp.daily_send_cap`). A
 *   guarded `UPDATE ... WHERE count < cap` is the only way it grows, so the cap holds under any concurrency and survives a cache flush.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('wa_messages', function (Blueprint $table) {
            $table->char('client_msg_id', 26)->nullable()->after('wa_message_id');
            $table->unique(['wa_chat_id', 'client_msg_id']);
            $table->index(['status', 'created_at']);
        });

        Schema::create('wa_send_counters', function (Blueprint $table) {
            $table->foreignId('session_id')->constrained('whatsapp_sessions')->cascadeOnDelete();
            $table->date('day');
            $table->unsignedInteger('count')->default(0);

            $table->primary(['session_id', 'day']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('wa_send_counters');

        Schema::table('wa_messages', function (Blueprint $table) {
            $table->dropIndex(['status', 'created_at']);
            $table->dropUnique(['wa_chat_id', 'client_msg_id']);
            $table->dropColumn('client_msg_id');
        });
    }
};
