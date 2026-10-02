<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Push notifications (P5, decision P5-D4).
 *
 * - `push_subscriptions`: one row per browser a staff member enabled notifications in. `endpoint_hash` (sha256 of the endpoint) is the
 *   unique key an upsert uses (the endpoint is a long text); `p256dh` and `auth` are the subscription's keys, encrypted at rest by the
 *   model cast. `ulid` is the public id the API uses. `session_hash` (sha256 of the web session that registered it) lets signing out
 *   remove the browser's subscription, so a shared computer stops showing the previous person's chats.
 * - `notification_settings`: one row per user (created when first needed): the preferences and the state of the first-login dialog.
 * - `device_tokens`: FCM registration tokens of a future mobile app (a stub for now; the token is encrypted, `token_hash` is the key).
 *
 * The tables carry only what the push needs: nothing about conversations, and no integer id ever leaves the server.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('push_subscriptions', function (Blueprint $table) {
            $table->id();
            $table->char('ulid', 26)->unique();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->char('endpoint_hash', 64)->unique();
            $table->text('endpoint');
            $table->text('p256dh');
            $table->text('auth');
            $table->string('content_encoding', 16)->default('aes128gcm');
            $table->string('user_agent', 255)->nullable();
            $table->char('session_hash', 64)->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('last_used_at')->nullable();
            $table->timestamps();

            $table->index('user_id');
            $table->index(['user_id', 'session_hash']);
        });

        Schema::create('notification_settings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->unique()->constrained('users')->cascadeOnDelete();
            $table->boolean('sound')->default(true);
            $table->boolean('push_offers')->default(true);
            $table->boolean('push_messages')->default(true);
            $table->boolean('include_preview')->default(true);
            $table->json('quiet_hours')->nullable();
            $table->string('prompt_state', 16)->default('never');
            $table->timestamp('prompted_at')->nullable();
            $table->timestamp('snoozed_until')->nullable();
            $table->timestamps();
        });

        Schema::create('device_tokens', function (Blueprint $table) {
            $table->id();
            $table->char('ulid', 26)->unique();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('platform', 16);
            $table->char('token_hash', 64)->unique();
            $table->text('token');
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamps();

            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_tokens');
        Schema::dropIfExists('notification_settings');
        Schema::dropIfExists('push_subscriptions');
    }
};
