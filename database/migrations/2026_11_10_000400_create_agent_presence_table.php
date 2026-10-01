<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per staff member: the DB mirror of agent presence. Minimal on purpose: P5 adds the Redis ZSET (source of
 * truth), auto-away and the sweep behind the same model. `is_manual` = the agent chose the status themselves.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_presence', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->unique()->constrained('users')->cascadeOnDelete();
            $table->string('status', 16)->default('offline');
            $table->boolean('is_manual')->default(false);
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamp('last_heartbeat_at')->nullable();
            $table->timestamps();

            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_presence');
    }
};
