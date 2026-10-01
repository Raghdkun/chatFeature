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
            $table->string('external_id', 255)->nullable();
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
            $table->timestamps();

            $table->index('expires_at');
            $table->index(['visitor_id', 'revoked_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('visitor_sessions');
        Schema::dropIfExists('visitors');
    }
};
