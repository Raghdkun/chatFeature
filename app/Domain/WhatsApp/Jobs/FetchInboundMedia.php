<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\WaMessage;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

/**
 * Fetches an inbound image OpenWA did not inline in the webhook (larger than about 768 KiB) from its media endpoint and stores it like
 * an inline one (`WaMediaStore`). OpenWA answers 404 when it holds nothing: that, a refusal, a file that is not a storable image and an
 * oversized one all leave the message as a typed row without a file. Only an OpenWA that cannot be reached is tried again (backoff
 * `whatsapp.media.fetch_backoff`, `whatsapp.media.fetch_tries` attempts).
 */
class FetchInboundMedia implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 4;

    public int $timeout = 60;

    public function __construct(public readonly int $messageId)
    {
        $this->tries = max(1, (int) config('whatsapp.media.fetch_tries', 4));
    }

    /**
     * @return list<int>
     */
    public function backoff(): array
    {
        return array_values(array_map(intval(...), (array) config('whatsapp.media.fetch_backoff', [10, 60, 300])));
    }

    public function handle(OpenWaClient $openWa, WaMediaStore $media): void
    {
        $message = WaMessage::query()->with('chat.session')->find($this->messageId);

        if ($message === null || $message->hasStoredMedia() || $message->wa_message_id === null) {
            return;
        }

        $session = $message->chat->session;

        if ($session->trashed() || $session->openwa_session_id === null) {
            return;
        }

        $raw = is_array($message->raw) ? $message->raw : [];
        $chatId = is_string($raw['chatId'] ?? null) && $raw['chatId'] !== '' ? $raw['chatId'] : $message->chat->chat_id;

        try {
            $file = $openWa->downloadMedia($session->openwa_session_id, $chatId, $message->wa_message_id);
        } catch (OpenWaRejected) {
            return;
        } catch (OpenWaUnavailable $unavailable) {
            if ($this->attempts() >= $this->tries) {
                return;
            }

            throw $unavailable;
        }

        if ($file === null) {
            return;
        }

        if ($media->store($message, $file->contents, $file->filename)) {
            $media->announce($message);
        }
    }
}
