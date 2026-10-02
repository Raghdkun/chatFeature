<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Recorded WhatsApp chats and the hand-off tickets that link them to a widget visitor (P6). WhatsApp never joins `conversations`.
 *
 * `wa_chats.chat_id` is the WhatsApp id as OpenWA reports it (`4915...@c.us`, a privacy id `...@lid` or a group `...@g.us`), unique
 * per session; binary-collated on MySQL / MariaDB (an id is an identifier: `AB` and `ab` are different ones). `widget_id` /
 * `visitor_id` / `category_id` are set when a hand-off ticket matched the first messages and go back to null when the widget, visitor
 * or category is deleted: the recorded chat stays. `unread_by_admin` counts inbound messages no admin has opened yet;
 * `inbound_initiated` is true when the customer wrote first (the only chats an admin may reply to by default).
 *
 * A ticket (`code`, 8 characters, globally unique) is live until `expires_at` or `consumed_at`. `wa_chats.handoff_ticket_id` and
 * `wa_handoff_tickets.wa_chat_id` point at each other (the ticket that linked the chat, the chat a ticket linked); both go back to
 * null when the other row is deleted (expired tickets are pruned), so the second foreign key is added after both tables exist.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('wa_chats', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->foreignId('session_id')->constrained('whatsapp_sessions')->cascadeOnDelete();
            $chatId = $table->string('chat_id', 128);
            $collation = $this->binaryCollation();

            if ($collation !== null) {
                $chatId->collation($collation);
            }

            $table->string('phone_e164', 20)->nullable()->index();
            $table->string('push_name', 120)->nullable();
            $table->boolean('is_group')->default(false);
            $table->string('status', 16)->default('open');
            $table->foreignId('widget_id')->nullable()->constrained('widgets')->nullOnDelete();
            $table->foreignId('visitor_id')->nullable()->constrained('visitors')->nullOnDelete();
            $table->foreignId('category_id')->nullable()->constrained('categories')->nullOnDelete();
            $table->unsignedBigInteger('handoff_ticket_id')->nullable()->index();
            $table->timestamp('last_inbound_at')->nullable();
            $table->timestamp('last_message_at')->nullable();
            $table->string('last_message_preview', 160)->nullable();
            $table->unsignedInteger('unread_by_admin')->default(0);
            $table->boolean('inbound_initiated')->default(false);
            $table->timestamps();

            $table->unique(['session_id', 'chat_id']);
            // The admin inbox: open / archived chats, newest activity first (also per session).
            $table->index(['status', 'last_message_at']);
            $table->index(['session_id', 'status', 'last_message_at'], 'wa_chats_session_list_index');
        });

        Schema::create('wa_handoff_tickets', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->foreignId('visitor_id')->nullable()->constrained('visitors')->nullOnDelete();
            $table->foreignId('category_id')->nullable()->constrained('categories')->nullOnDelete();
            $table->foreignId('session_id')->constrained('whatsapp_sessions')->cascadeOnDelete();
            $table->char('code', 8)->unique();
            $table->timestamp('expires_at');
            $table->timestamp('consumed_at')->nullable();
            $table->foreignId('wa_chat_id')->nullable()->constrained('wa_chats')->nullOnDelete();
            $table->timestamps();

            // Pruning of expired tickets, and "the live tickets of a session".
            $table->index('expires_at');
            $table->index(['session_id', 'expires_at']);
        });

        Schema::table('wa_chats', function (Blueprint $table) {
            $table->foreign('handoff_ticket_id')->references('id')->on('wa_handoff_tickets')->nullOnDelete();
        });
    }

    /** A binary, NO PAD collation for the server in use (`utf8mb4_bin` would still ignore trailing spaces), none on SQLite. */
    private function binaryCollation(): ?string
    {
        $connection = Schema::getConnection();

        if (! in_array($connection->getDriverName(), ['mysql', 'mariadb'], true)) {
            return null;
        }

        $version = strtolower((string) $connection->getPdo()->getAttribute(PDO::ATTR_SERVER_VERSION));

        return str_contains($version, 'mariadb') ? 'utf8mb4_nopad_bin' : 'utf8mb4_0900_bin';
    }

    public function down(): void
    {
        Schema::table('wa_chats', function (Blueprint $table) {
            $table->dropForeign(['handoff_ticket_id']);
        });

        Schema::dropIfExists('wa_handoff_tickets');
        Schema::dropIfExists('wa_chats');
    }
};
