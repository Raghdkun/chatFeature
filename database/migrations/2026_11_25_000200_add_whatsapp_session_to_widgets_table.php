<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Which WhatsApp session (number) a widget hands visitors over to (P6). Null = the widget offers no WhatsApp channel. The link goes
 * back to null when the session row is hard-deleted; a soft-deleted session keeps its id here, but `Widget::whatsappSession()` then
 * resolves to nothing (the soft delete hides it), so it behaves as unlinked.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('widgets', function (Blueprint $table) {
            $table->foreignId('whatsapp_session_id')->nullable()->after('allow_non_browser_clients')
                ->constrained('whatsapp_sessions')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('widgets', function (Blueprint $table) {
            $table->dropConstrainedForeignId('whatsapp_session_id');
        });
    }
};
