<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('processed_events', function (Blueprint $table) {
            $table->char('event_id', 26)->primary();
            $table->string('type', 128);
            $table->string('subject', 128);
            $table->string('outcome', 32);
            $table->timestamp('processed_at')->useCurrent()->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('processed_events');
    }
};
