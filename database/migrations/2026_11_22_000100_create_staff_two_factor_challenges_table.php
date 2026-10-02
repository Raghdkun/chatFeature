<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The half-finished native sign-ins of staff with two-factor authentication: the password was right, the second factor is still owed.
 * One short-lived row per challenge; the secret that identifies it is only ever stored as a sha256. Rows are single use (`consumed_at`)
 * and burn after a few wrong codes (`attempts`); `chat:auth:prune-sessions` deletes the old ones.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('staff_two_factor_challenges', function (Blueprint $table) {
            $table->id();
            $table->char('token_hash', 64)->unique();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('device_name', 60);
            $table->unsignedTinyInteger('attempts')->default(0);
            $table->timestamp('expires_at');
            $table->timestamp('consumed_at')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index('expires_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('staff_two_factor_challenges');
    }
};
