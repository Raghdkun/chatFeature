<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Visitors and their sessions (P4).
 *
 * A visitor is anonymous unless the host site vouched for them with a signed identity (`external_id` = the token's
 * `sub`, `verified` = true). `(widget_id, external_id)` is unique; rows without an external id never collide
 * (NULLs are distinct in a UNIQUE index on both MySQL and SQLite, which is what anonymous visitors need).
 * `workspace_key` is not needed here: no unique index spans the workspace (the widget already implies it).
 *
 * `external_id` is an identifier owned by the host website: `John` and `john`, `josé` and `jose` are different people. MySQL's default
 * collations compare case- and accent-insensitively, which would fold them into ONE visitor (and one chat), so the column (and with
 * it the unique index) is binary and unpadded on MySQL / MariaDB; SQLite compares exactly already.
 *
 * `visitor_sessions.network_hash` is an HMAC of the client network the session was opened from (never the address itself); it only
 * serves the cap on chats queued from one network.
 *
 * `visitor_sessions.token_hash` is the sha256 (hex) of the plaintext `vt_...` token; the plaintext is returned once
 * when the session is created and never stored.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('visitors', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $external = $table->string('external_id', 255)->nullable();
            $collation = $this->externalIdCollation();

            if ($collation !== null) {
                $external->collation($collation);
            }

            $table->boolean('verified')->default(false);
            $table->string('name', 120)->nullable();
            $table->string('email', 190)->nullable();
            $table->string('phone', 40)->nullable();
            $table->json('meta')->nullable();
            $table->timestamp('first_seen_at')->nullable();
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamps();

            $table->unique(['widget_id', 'external_id']);
        });

        Schema::create('visitor_sessions', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('visitor_id')->constrained('visitors')->cascadeOnDelete();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->char('token_hash', 64)->unique();
            $table->timestamp('expires_at');
            $table->timestamp('revoked_at')->nullable();
            $table->timestamp('last_used_at')->nullable();
            $table->string('page_url', 2048)->nullable();
            $table->string('page_title', 255)->nullable();
            $table->string('referrer', 2048)->nullable();
            $table->string('user_agent', 255)->nullable();
            $table->string('locale', 12)->nullable();
            $table->char('network_hash', 64)->nullable();
            $table->timestamps();

            $table->index('expires_at');
            $table->index(['visitor_id', 'revoked_at']);
            $table->index(['widget_id', 'network_hash']);
        });
    }

    /** A binary, NO PAD collation for the server in use (`utf8mb4_bin` would still ignore trailing spaces), none on SQLite. */
    private function externalIdCollation(): ?string
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
        Schema::dropIfExists('visitor_sessions');
        Schema::dropIfExists('visitors');
    }
};
