<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Support categories and the agents who serve them.
 *
 * `workspace_key` is a virtual COALESCE(workspace_id, 0) so (workspace_key, slug) is really unique for
 * global rows (a MySQL NULL in a UNIQUE index never collides). Deleting a category is soft and frees its
 * slug (the delete action renames it), so the unique index can stay a plain one.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('categories', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->unsignedBigInteger('workspace_key')->virtualAs('COALESCE(workspace_id, 0)');
            $table->string('slug', 64);
            $table->string('name', 120);
            $table->json('name_i18n')->nullable();
            $table->text('description')->nullable();
            $table->string('icon', 64)->nullable();
            $table->string('color', 16)->nullable();
            $table->unsignedInteger('sort_order')->default(0);
            $table->boolean('is_active')->default(true);
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['workspace_key', 'slug']);
            $table->index(['is_active', 'sort_order']);
        });

        Schema::create('category_user', function (Blueprint $table) {
            $table->foreignId('category_id')->constrained('categories')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->timestamps();

            $table->primary(['category_id', 'user_id']);
            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('category_user');
        Schema::dropIfExists('categories');
    }
};
