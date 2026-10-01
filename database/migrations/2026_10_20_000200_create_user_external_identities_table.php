<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Links a local (shadow) user to its account in an auth-portal environment. `external_id` is the
 * pizzasys `sub`; the unique key makes (environment, sub) resolve to exactly one identity.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_external_identities', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('auth_environment_id')->constrained('auth_environments')->cascadeOnDelete();
            $table->string('external_id', 64);
            $table->json('roles');
            $table->json('permissions');
            $table->boolean('active')->default(true);
            $table->timestamp('last_verified_at')->nullable();
            $table->timestamp('stale_at')->nullable();
            $table->timestamp('deactivated_at')->nullable();
            $table->timestamps();

            $table->unique(['auth_environment_id', 'external_id']);
            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_external_identities');
    }
};
