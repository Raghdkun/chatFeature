<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Typed key/value settings. `workspace_key` is a virtual COALESCE(workspace_id, 0) so the
 * (workspace_key, key) unique index really is unique for global rows (a MySQL NULL in a
 * UNIQUE index never collides).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('settings', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->unsignedBigInteger('workspace_key')->virtualAs('COALESCE(workspace_id, 0)');
            $table->string('group', 64);
            $table->string('key', 128);
            $table->longText('value')->nullable();
            $table->boolean('is_encrypted')->default(false);
            $table->unsignedBigInteger('updated_by')->nullable();
            $table->timestamps();

            $table->unique(['workspace_key', 'key']);
            $table->index('group');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('settings');
    }
};
