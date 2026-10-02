<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Http\Controllers\Controller;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia pages `whatsapp/index` and `whatsapp/show` (administrators only: the `wa.admin` middleware of the route group, and the
 * `WhatsAppPolicy` again here). The props are the first picture only: the first page of open chats, the sessions, the newest messages of
 * one chat. Filters, search, "load more" and everything after the first paint go through the management API and the websocket.
 */
class WhatsAppInboxPageController extends Controller
{
    /** Chats the list starts with (the client reads further pages through the API). */
    public const CHAT_PAGE = 50;

    /** Messages of a chat the page starts with (older ones are read on request). */
    public const MESSAGE_PAGE = 100;

    public function index(): Response
    {
        Gate::authorize('viewAny', WaChat::class);

        return Inertia::render('whatsapp/index', $this->shell());
    }

    public function show(WaChat $chat, WaMediaUrls $urls): Response
    {
        Gate::authorize('view', $chat);

        $chat->load(['session', 'widget', 'category', 'visitor', 'handoffTicket']);

        // The newest page, oldest first; one row more than the page says whether older history exists.
        $rows = $chat->messages()->reorder('id', 'desc')->with('sentBy')->limit(self::MESSAGE_PAGE + 1)->get();
        $hasOlder = $rows->count() > self::MESSAGE_PAGE;

        return Inertia::render('whatsapp/show', [
            ...$this->shell(),
            'detail' => WaChatDetailData::fromModel($chat)->toArray(),
            'messages' => $rows->take(self::MESSAGE_PAGE)->reverse()->values()
                ->map(function (WaMessage $message) use ($chat, $urls): array {
                    $message->setRelation('chat', $chat);

                    return WaMessageData::fromModel($message, $urls)->toArray();
                })->all(),
            'hasOlder' => $hasOlder,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function shell(): array
    {
        $rows = WaChat::query()->open()
            ->with(['session', 'widget', 'category'])
            ->orderByDesc('last_message_at')
            ->orderByDesc('id')
            ->limit(self::CHAT_PAGE + 1)
            ->get();

        return [
            'chats' => $rows->take(self::CHAT_PAGE)
                ->map(fn (WaChat $chat): array => WaChatData::fromModel($chat)->toArray())->values()->all(),
            'hasMore' => $rows->count() > self::CHAT_PAGE,
            'sessions' => WhatsAppSession::query()->withCount('widgets')->orderBy('name')->get()
                ->map(fn (WhatsAppSession $session): array => WhatsAppSessionData::fromModel($session)->toArray())->values()->all(),
            'replyOnlyToInbound' => settings()->bool('whatsapp.reply_only_to_inbound', true),
        ];
    }
}
