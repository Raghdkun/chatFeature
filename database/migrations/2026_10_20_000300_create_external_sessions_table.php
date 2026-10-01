<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per signed-in dashboard session or mobile token in mode 2. It holds the upstream user token
 * (encrypted, never sent to a client) that is re-verified against the portal; the token column is wiped
 * when the session is revoked.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('external_sessions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('identity_id')->constrained('user_external_identities')->cascadeOnDelete();
            $table->foreignId('auth_environment_id')->constrained('auth_environments')->cascadeOnDelete();
            $table->string('laravel_session_id', 64)->nullable()->index();
            $table->unsignedBigInteger('sanctum_token_id')->nullable()->index();
            $table->text('token_encrypted')->nullable();
            $table->timestamp('last_verified_at');
            $table->unsignedSmallInteger('verify_fail_count')->default(0);
            $table->timestamp('revoked_at')->nullable();
            $table->string('revoked_reason', 64)->nullable();
            $table->string('ip', 45)->nullable();
            $table->string('user_agent', 512)->nullable();
            $table->timestamps();

            $table->index(['user_id', 'revoked_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('external_sessions');
    }
};
