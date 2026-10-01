<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Staff-oriented columns on the starter-kit users table (additive; existing columns are kept).
 *
 * `is_admin` / `is_agent` are the only role flags the application reads (docs/contracts/auth-driver.md);
 * `role` is the local-mode source of truth that `LocalRoleResolver` derives them from.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->unsignedBigInteger('workspace_id')->nullable()->after('id')->index();
            $table->string('role', 16)->default('agent')->after('remember_token');
            $table->boolean('is_admin')->default(false)->after('role');
            $table->boolean('is_agent')->default(false)->after('is_admin');
            $table->boolean('is_active')->default(true)->after('is_agent');
            $table->string('display_name')->nullable()->after('is_active');
            $table->string('avatar_path')->nullable()->after('display_name');
            $table->string('locale', 12)->nullable()->after('avatar_path');
            $table->string('timezone', 64)->nullable()->after('locale');
            $table->unsignedSmallInteger('max_concurrent_chats')->default(5)->after('timezone');
            $table->timestamp('last_seen_at')->nullable()->after('max_concurrent_chats');
            $table->string('auth_source', 32)->default('local')->after('last_seen_at');

            $table->index(['is_active', 'is_agent']);
        });

        // Users created by an external auth portal (mode 2) have no local password.
        Schema::table('users', function (Blueprint $table) {
            $table->string('password')->nullable()->change();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropIndex(['is_active', 'is_agent']);
            $table->dropIndex(['workspace_id']);
        });

        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn([
                'workspace_id',
                'role',
                'is_admin',
                'is_agent',
                'is_active',
                'display_name',
                'avatar_path',
                'locale',
                'timezone',
                'max_concurrent_chats',
                'last_seen_at',
                'auth_source',
            ]);
        });
    }
};
