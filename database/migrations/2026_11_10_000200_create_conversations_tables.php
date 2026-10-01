<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Conversations (P4): the live chats and offline tickets, their audit trail and the offers sent to agents.
 *
 * Statuses and types are plain strings backed by App\Domain\Chat\Enums (no DB enums: adding a case needs no ALTER).
 * `last_seq` is the per-conversation message counter, `claim_version` counts claims (bumped by the atomic accept),
 * `wave` is the routing wave reached so far. Every sweep (queue expiry, idle close, rating window) has its own
 * `(status, <deadline>)` index so the scheduled jobs never scan the table.
 *
 * `conversation_agent_alerts` holds the offers; the model is `ConversationOffer`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversations', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->foreignId('visitor_id')->constrained('visitors')->cascadeOnDelete();
            $table->foreignId('visitor_session_id')->nullable()->constrained('visitor_sessions')->nullOnDelete();
            $table->foreignId('category_id')->nullable()->constrained('categories')->nullOnDelete();
            $table->string('ticket_no', 12)->unique();
            $table->string('type', 16)->default('live');
            $table->string('status', 16)->default('queued');
            $table->foreignId('assigned_agent_id')->nullable()->constrained('users')->nullOnDelete();
            $table->unsignedInteger('last_seq')->default(0);
            $table->unsignedInteger('claim_version')->default(0);
            $table->unsignedTinyInteger('wave')->default(0);
            $table->timestamp('queued_at')->nullable();
            $table->timestamp('queue_expires_at')->nullable();
            $table->timestamp('claimed_at')->nullable();
            $table->timestamp('ended_at')->nullable();
            $table->timestamp('closed_at')->nullable();
            $table->string('ended_by', 16)->nullable();
            $table->string('close_reason', 16)->nullable();
            $table->timestamp('last_activity_at')->nullable();
            $table->timestamp('idle_expires_at')->nullable();
            $table->timestamp('last_message_at')->nullable();
            $table->string('last_message_preview', 160)->nullable();
            $table->unsignedInteger('unseen_by_agent')->default(0);
            $table->unsignedInteger('unseen_by_visitor')->default(0);
            $table->boolean('rating_requested')->default(false);
            $table->timestamp('rating_window_expires_at')->nullable();
            $table->timestamps();

            // Staff queue, agent list, offline tickets.
            $table->index(['status', 'queued_at']);
            $table->index(['assigned_agent_id', 'status', 'last_message_at'], 'conversations_agent_list_index');
            $table->index(['type', 'status', 'created_at']);
            // Admin history filters (widget / category / status, newest first) and `updated_after` refetches.
            $table->index(['widget_id', 'created_at']);
            $table->index(['category_id', 'created_at']);
            $table->index(['status', 'created_at']);
            $table->index('updated_at');
            // One open conversation per visitor / per session.
            $table->index(['visitor_id', 'type', 'status'], 'conversations_visitor_open_index');
            $table->index(['visitor_session_id', 'status'], 'conversations_session_open_index');
            // Sweeps: queue expiry, idle close, rating window.
            $table->index(['status', 'queue_expires_at']);
            $table->index(['status', 'idle_expires_at']);
            $table->index(['status', 'rating_window_expires_at'], 'conversations_rating_sweep_index');
        });

        Schema::create('conversation_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained('conversations')->cascadeOnDelete();
            $table->string('type', 40);
            $table->string('actor_type', 16)->nullable();
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->json('payload')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['conversation_id', 'id']);
        });

        Schema::create('conversation_agent_alerts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained('conversations')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->unsignedTinyInteger('wave')->default(1);
            $table->timestamp('offered_at');
            $table->timestamp('expires_at');
            $table->timestamp('responded_at')->nullable();
            $table->string('response', 16)->nullable();

            $table->unique(['conversation_id', 'user_id']);
            $table->index(['user_id', 'responded_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversation_agent_alerts');
        Schema::dropIfExists('conversation_events');
        Schema::dropIfExists('conversations');
    }
};
