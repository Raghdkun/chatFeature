<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use Illuminate\Support\Facades\Storage;

/**
 * `whatsapp:prune` (daily): the idempotency ledger past its 30 days (OpenWA never repeats a delivery that late), hand-off tickets that expired
 * unused (a consumed ticket is kept: it says where a chat came from), and stored media no message points to any more (a half-finished write,
 * a deleted chat) once it is older than a day. Chats and messages are never pruned: they are the record.
 */
final class PruneWhatsApp
{
    private const BATCH = 1000;

    /**
     * @return array{deliveries: int, tickets: int, media: int}
     */
    public function handle(int $deliveryDays = 30, int $ticketDays = 1, int $mediaHours = 24): array
    {
        return [
            'deliveries' => $this->deliveries($deliveryDays),
            'tickets' => $this->tickets($ticketDays),
            'media' => $this->media($mediaHours),
        ];
    }

    private function deliveries(int $days): int
    {
        $deleted = 0;
        $cutoff = now()->subDays(max(1, $days));

        do {
            $ids = WaWebhookDelivery::query()->where('received_at', '<', $cutoff)->orderBy('id')->limit(self::BATCH)->pluck('id');
            $count = $ids->isEmpty() ? 0 : WaWebhookDelivery::query()->whereIn('id', $ids)->delete();
            $deleted += $count;
        } while ($count === self::BATCH);

        return $deleted;
    }

    private function tickets(int $days): int
    {
        $deleted = 0;
        $cutoff = now()->subDays(max(0, $days));

        do {
            $ids = WaHandoffTicket::query()->whereNull('consumed_at')->whereNull('wa_chat_id')->where('expires_at', '<', $cutoff)->orderBy('id')->limit(self::BATCH)->pluck('id');
            $count = $ids->isEmpty() ? 0 : WaHandoffTicket::query()->whereIn('id', $ids)->delete();
            $deleted += $count;
        } while ($count === self::BATCH);

        return $deleted;
    }

    private function media(int $hours): int
    {
        $disk = Storage::disk(WaMediaStore::disk());
        $cutoff = now()->subHours(max(1, $hours))->getTimestamp();
        $deleted = 0;

        foreach (array_chunk($disk->allFiles('whatsapp/media'), 500) as $paths) {
            $referenced = WaMessage::query()->whereIn('media_path', $paths)->pluck('media_path')->all();

            foreach (array_diff($paths, $referenced) as $path) {
                if ($disk->lastModified($path) < $cutoff) {
                    $disk->delete($path);
                    $deleted++;
                }
            }
        }

        return $deleted;
    }
}
