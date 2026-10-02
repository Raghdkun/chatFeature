<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Webhook deliveries received from OpenWA (P6): the idempotency ledger. OpenWA delivers at least once and derives
 * `X-OpenWA-Idempotency-Key` from the content (stable across retries), so `(session_id, idempotency_key)` is UNIQUE: the first insert
 * wins and a repeat is a no-op. The row is written when the delivery is accepted (outcome NULL = accepted, queued for processing) and
 * completed by the job (`outcome`, `processed_at`, `error`). Deliveries are pruned by age through `received_at`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('wa_webhook_deliveries', function (Blueprint $table) {
            $table->id();
            $table->foreignId('session_id')->constrained('whatsapp_sessions')->cascadeOnDelete();
            $key = $table->string('idempotency_key', 255);
            $collation = $this->binaryCollation();

            if ($collation !== null) {
                $key->collation($collation);
            }

            $table->string('delivery_id', 64)->nullable();
            $table->string('event', 48);
            $table->string('outcome', 16)->nullable();
            $table->timestamp('received_at')->useCurrent();
            $table->timestamp('processed_at')->nullable();
            $table->text('error')->nullable();

            $table->unique(['session_id', 'idempotency_key']);
            $table->index('received_at');
        });
    }

    /** A binary, NO PAD collation for the server in use (`utf8mb4_bin` would still ignore trailing spaces), none on SQLite. */
    private function binaryCollation(): ?string
    {
        $connection = Schema::getConnection();

        if (! in_array($connection->getDriverName(), ['mysql', 'mariadb'], true)) {
            return null;
        }

        $version = strtolower((string) $connection->getPdo()->getAttribute(PDO::ATTR_SERVER_VERSION));

        return str_contains($version, 'mariadb') ? 'utf8mb4_nopad_bin' : 'utf8mb4_0900_bin';
    }

    public function down(): void
    {
        Schema::dropIfExists('wa_webhook_deliveries');
    }
};
