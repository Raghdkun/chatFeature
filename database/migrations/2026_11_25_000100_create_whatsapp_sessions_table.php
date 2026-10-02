<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * WhatsApp sessions (P6): one row per number linked through the self-hosted OpenWA gateway.
 *
 * `openwa_session_id` is the id OpenWA assigned (a UUID); `status` follows App\Domain\WhatsApp\Enums\SessionStatus (a plain string,
 * adding a case needs no ALTER). The webhook secret is encrypted with the app key (`webhook_secret_encrypted`) because OpenWA never
 * returns it, and `last_qr` is encrypted too: scanning it links the account. `settings` holds per-session pacing overrides
 * (`send_min_interval_ms`, `daily_send_cap`); anything unset falls back to the `whatsapp.*` settings.
 *
 * Sessions are soft-deleted so the chats recorded through them stay readable. `name` must be unique among live sessions only (OpenWA
 * has one name space and answers 409 on a duplicate): `name_key` is a virtual column that is the name while the row is live and NULL
 * once it is deleted, and a NULL never collides in a UNIQUE index (MySQL, MariaDB, SQLite), so a deleted session frees its name.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('whatsapp_sessions', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->string('name', 50);
            $table->string('name_key', 50)->nullable()->virtualAs('CASE WHEN deleted_at IS NULL THEN name END');
            $table->string('openwa_session_id', 64)->nullable()->unique();
            $table->string('openwa_webhook_id', 64)->nullable();
            $table->string('engine', 32)->default('whatsapp-web.js');
            $table->string('status', 16)->default('created');
            $table->string('phone_e164', 20)->nullable();
            $table->string('push_name', 120)->nullable();
            $table->text('webhook_secret_encrypted')->nullable();
            $table->timestamp('webhook_registered_at')->nullable();
            $table->text('last_qr')->nullable();
            $table->timestamp('last_qr_at')->nullable();
            $table->timestamp('ready_at')->nullable();
            $table->text('last_error')->nullable();
            $table->json('settings')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->unique('name_key');
            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('whatsapp_sessions');
    }
};
