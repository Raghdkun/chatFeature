<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Auth mode 2 (pizzasys): one row per configured portal environment (`production`, `testing`).
 * Secrets (service token, NATS token) are stored ONLY here, encrypted with the application key.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('auth_environments', function (Blueprint $table) {
            $table->id();
            $table->string('key', 16)->unique();
            $table->string('label', 64);
            $table->string('base_url', 255);
            $table->string('api_prefix', 64)->default('/api/v1');
            $table->string('service_name', 64);
            $table->text('service_token_encrypted');
            $table->string('nats_url', 255)->nullable();
            $table->text('nats_token_encrypted')->nullable();
            $table->string('nats_stream', 64)->default('AUTH_EVENTS');
            $table->boolean('verify_tls')->default(true);
            $table->timestamp('last_check_at')->nullable();
            $table->string('last_check_status', 16)->nullable();
            $table->string('last_check_message', 255)->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('auth_environments');
    }
};
