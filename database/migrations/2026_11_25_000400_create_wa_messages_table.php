<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Recorded WhatsApp messages (P6), inbound and outbound.
 *
 * `(wa_chat_id, wa_message_id)` is UNIQUE so a re-delivered webhook (or the `message.sent` echo of a reply the app already stored) never
 * duplicates a row; outbound rows exist before OpenWA answers, so `wa_message_id` is NULL until then (NULL never collides). Acks carry no
 * chat id, hence the plain index on `wa_message_id`. `raw` keeps the webhook's message object as received (tolerant parser, never sent
 * to a client). `media_path` is a key on the private disk (images only in P6); the other media types are recorded as typed rows with
 * their file name, mime and size. `wa_message_id` is binary-collated on MySQL / MariaDB (WhatsApp ids are case-sensitive identifiers). The FULLTEXT index on `body` (admin search) exists on MySQL / MariaDB only; SQLite (the test database) skips it.
 */
return new class extends Migration
{
    public function up(): void
    {
        $fullText = in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);

        Schema::create('wa_messages', function (Blueprint $table) use ($fullText) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('wa_chat_id')->constrained('wa_chats')->cascadeOnDelete();
            $table->string('direction', 8);
            $waMessageId = $table->string('wa_message_id', 128)->nullable();
            $collation = $this->binaryCollation();

            if ($collation !== null) {
                $waMessageId->collation($collation);
            }

            $table->string('type', 16)->default('text');
            $table->text('body')->nullable();
            $table->string('media_path', 512)->nullable();
            $table->string('media_mime', 100)->nullable();
            $table->string('media_filename', 255)->nullable();
            $table->unsignedBigInteger('media_size')->nullable();
            $table->foreignId('sent_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('status', 16)->default('received');
            $table->text('error')->nullable();
            $table->timestamp('wa_timestamp')->useCurrent();
            $table->json('raw')->nullable();
            $table->timestamps();

            $table->unique(['wa_chat_id', 'wa_message_id']);
            // A chat's transcript, oldest first, paged by id.
            $table->index(['wa_chat_id', 'id']);
            $table->index('wa_message_id');

            if ($fullText) {
                $table->fullText('body');
            }
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
        Schema::dropIfExists('wa_messages');
    }
};
