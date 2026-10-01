<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Embeddable chat widgets: published + draft config, allowed domains, greeting pool, enabled categories.
 *
 * `public_key` (`wk_` + 20 lower-case url-safe characters) is the only identifier visitors ever see.
 * `identity_secret_encrypted` holds the HS256 secret for signed visitor identities (encrypted with the app key).
 * The WhatsApp session link is added by P6.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('widgets', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->unsignedBigInteger('workspace_id')->nullable()->index();
            $table->unsignedBigInteger('workspace_key')->virtualAs('COALESCE(workspace_id, 0)');
            $table->string('public_key', 32)->unique();
            $table->string('name', 120);
            $table->boolean('is_enabled')->default(false);
            $table->string('locale', 12)->default('en');
            $table->json('config');
            $table->json('draft_config');
            $table->unsignedInteger('config_version')->default(1);
            $table->unsignedInteger('idle_timeout_minutes')->default(120);
            $table->unsignedInteger('queue_timeout_seconds')->default(90);
            $table->string('offline_mode', 16)->default('auto_hours');
            $table->string('timezone', 64)->default('UTC');
            $table->boolean('allow_non_browser_clients')->default(false);
            $table->text('identity_secret_encrypted')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['workspace_key', 'is_enabled']);
        });

        Schema::create('widget_domains', function (Blueprint $table) {
            $table->id();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->string('host', 255);
            $table->boolean('is_wildcard')->default(false);
            $table->timestamps();

            $table->unique(['widget_id', 'host']);
        });

        Schema::create('widget_category', function (Blueprint $table) {
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->foreignId('category_id')->constrained('categories')->cascadeOnDelete();
            $table->unsignedInteger('sort_order')->default(0);
            $table->timestamps();

            $table->primary(['widget_id', 'category_id']);
            $table->index('category_id');
        });

        Schema::create('widget_greetings', function (Blueprint $table) {
            $table->id();
            $table->ulid('ulid')->unique();
            $table->foreignId('widget_id')->constrained('widgets')->cascadeOnDelete();
            $table->text('body');
            $table->string('agent_name', 120)->nullable();
            $table->string('agent_avatar_url', 2048)->nullable();
            $table->string('locale', 12)->nullable();
            $table->unsignedSmallInteger('weight')->default(1);
            $table->boolean('is_active')->default(true);
            $table->unsignedInteger('sort_order')->default(0);
            $table->timestamps();

            $table->index(['widget_id', 'is_active', 'sort_order']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('widget_greetings');
        Schema::dropIfExists('widget_category');
        Schema::dropIfExists('widget_domains');
        Schema::dropIfExists('widgets');
    }
};
