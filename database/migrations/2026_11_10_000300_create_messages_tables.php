<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Messages, attachments and ratings (P4).
 *
 * `(conversation_id, seq)` is the ordering contract (clients merge by it) and `(conversation_id, client_msg_id)` makes
 * sends idempotent; both are plain UNIQUE indexes, and a NULL `client_msg_id` (agent / system messages) never collides.
 * The FULLTEXT index on `body` (staff search) exists on MySQL / MariaDB only; SQLite (the test database) skips it.
 */
return new class extends Migration
{
    public function up(): void
    {
        $fullText = in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);

        Schema::create('messages', function (Blueprint $table) use ($fullText) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('conversation_id')->constrained('conversations')->cascadeOnDelete();
            $table->unsignedInteger('seq');
            $table->string('sender_type', 16);
            $table->foreignId('sender_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('type', 16)->default('text');
            $table->text('body')->nullable();
            $table->char('client_msg_id', 26)->nullable();
            $table->timestamp('delivered_at')->nullable();
            $table->timestamp('seen_at')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->unique(['conversation_id', 'seq']);
            $table->unique(['conversation_id', 'client_msg_id']);

            if ($fullText) {
                $table->fullText('body');
            }
        });

        Schema::create('attachments', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('conversation_id')->constrained('conversations')->cascadeOnDelete();
            $table->foreignId('message_id')->nullable()->constrained('messages')->nullOnDelete();
            $table->string('uploader_type', 16);
            $table->foreignId('uploader_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('disk', 32);
            $table->string('path', 512);
            $table->string('thumb_path', 512)->nullable();
            $table->string('mime', 100);
            $table->unsignedInteger('size');
            $table->unsignedSmallInteger('width')->nullable();
            $table->unsignedSmallInteger('height')->nullable();
            $table->char('sha256', 64);
            $table->string('original_name', 120)->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index('message_id');
        });

        Schema::create('ratings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->unique()->constrained('conversations')->cascadeOnDelete();
            $table->unsignedTinyInteger('score');
            $table->text('comment')->nullable();
            $table->timestamp('created_at')->useCurrent();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ratings');
        Schema::dropIfExists('attachments');
        Schema::dropIfExists('messages');
    }
};
