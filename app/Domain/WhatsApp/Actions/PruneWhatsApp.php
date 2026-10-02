<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use Illuminate\Support\Facades\Storage;

/**
 * `whatsapp:prune` (daily): the idempotency ledger past its 30 days (OpenWA never repeats a delivery that late), hand-off tickets that expired
 * unused (a consumed ticket is kept: it says where a chat came from), and stored media no message points to any more (a half-finished write,
 * a deleted chat) once it is older than a day.
 *
 * What the administrator's RETENTION settings ask for (docs/security.md, "Retention and erasure"):
 *  - `whatsapp.raw_retention_days` (default 30): the raw webhook object kept in `wa_messages.raw` for debugging is dropped after that many
 *    days (0 = at once; it is not even stored then), and so are the raw bodies of failed deliveries still waiting for a replay;
 *  - `whatsapp.retention_days` (default 0 = keep for ever): messages older than that, with their stored images, are deleted, then the
 *    chats nothing is left in. Without a setting, chats and messages are never pruned: they are the record.
 */
final class PruneWhatsApp
{
    private const BATCH = 1000;

    /**
     * @return array{deliveries: int, tickets: int, media: int, raw: int, bodies: int, messages: int, chats: int}
     */
    public function handle(int $deliveryDays = 30, int $ticketDays = 1, int $mediaHours = 24): array
    {
        $retention = max(0, settings()->int('whatsapp.retention_days', 0));
        $rawRetention = max(0, settings()->int('whatsapp.raw_retention_days', 30));

        return [
            'deliveries' => $this->deliveries($deliveryDays),
            'tickets' => $this->tickets($ticketDays),
            'raw' => $this->raw($rawRetention),
            'bodies' => $this->bodies($rawRetention),
            'messages' => $retention > 0 ? $this->messages($retention) : 0,
            'chats' => $retention > 0 ? $this->chats($retention) : 0,
            // Last: it also removes the files of the messages deleted just above.
            'media' => $this->media($mediaHours),
        ];
    }

    /** The raw webhook object of messages older than the retention (0 days = every one that is left). */
    private function raw(int $days): int
    {
        $cutoff = now()->subDays($days);
        $cleared = 0;

        do {
            $ids = WaMessage::query()->whereNotNull('raw')->where('created_at', '<=', $cutoff)->orderBy('id')->limit(self::BATCH)->pluck('id');
            $count = $ids->isEmpty() ? 0 : WaMessage::query()->whereIn('id', $ids)->toBase()->update(['raw' => null]);
            $cleared += $count;
        } while ($count === self::BATCH);

        return $cleared;
    }

    /** The raw bodies kept on failed deliveries (for the replay): at least a day, at most the raw retention. */
    private function bodies(int $rawDays): int
    {
        $cutoff = now()->subDays(max(1, $rawDays));
        $cleared = 0;

        do {
            $ids = WaWebhookDelivery::query()->whereNotNull('body')->where('received_at', '<', $cutoff)->orderBy('id')->limit(self::BATCH)->pluck('id');
            $count = $ids->isEmpty() ? 0 : WaWebhookDelivery::query()->whereIn('id', $ids)->update(['body' => null]);
            $cleared += $count;
        } while ($count === self::BATCH);

        return $cleared;
    }

    /** Messages older than the retention, and the files of the images among them. */
    private function messages(int $days): int
    {
        $cutoff = now()->subDays($days);
        $deleted = 0;
        $disk = Storage::disk(WaMediaStore::disk());

        do {
            $rows = WaMessage::query()->where('wa_timestamp', '<', $cutoff)->orderBy('id')->limit(self::BATCH)->get(['id', 'media_path']);

            foreach ($rows as $row) {
                if ($row->media_path !== null && $row->media_path !== '') {
                    $disk->delete($row->media_path);
                }
            }

            $count = $rows->isEmpty() ? 0 : WaMessage::query()->whereIn('id', $rows->pluck('id'))->delete();
            $deleted += $count;
        } while ($count === self::BATCH);

        return $deleted;
    }

    /** Chats that nothing is left in and that have been quiet for the retention. */
    private function chats(int $days): int
    {
        $cutoff = now()->subDays($days);
        $deleted = 0;

        do {
            $ids = WaChat::query()
                ->whereDoesntHave('messages')
                ->where('created_at', '<', $cutoff)
                ->where(fn ($query) => $query->whereNull('last_message_at')->orWhere('last_message_at', '<', $cutoff))
                ->orderBy('id')
                ->limit(self::BATCH)
                ->pluck('id');
            $count = $ids->isEmpty() ? 0 : WaChat::query()->whereIn('id', $ids)->delete();
            $deleted += $count;
        } while ($count === self::BATCH);

        return $deleted;
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
