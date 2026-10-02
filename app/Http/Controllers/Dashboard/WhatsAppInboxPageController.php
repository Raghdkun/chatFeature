<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\Chat\CategoryRefData;
use App\Data\Chat\WidgetRefData;
use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The Inertia page `whatsapp/inbox` (administrators only: the `wa.admin` middleware of the route group, and the `WhatsAppPolicy` again here)
 * at `/whatsapp` and `/whatsapp/chats/{chat}` (the page is the same; `selected` is the open chat). The props are the contract of
 * docs/rest-api.md ("WhatsApp API (P6)", Inertia pages): the first page of open chats, the sessions, the widgets and topics to filter by,
 * the newest messages of one chat. Filters, search, "load more" and everything after the first paint go through the management API and
 * the websocket. `replyOnlyToInbound` is an addition: the composer says early that a chat the customer never started cannot be answered.
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

        return Inertia::render('whatsapp/inbox', [...$this->shell(), 'selected' => null]);
    }

    public function show(WaChat $chat, WaMediaUrls $urls): Response
    {
        Gate::authorize('view', $chat);

        $chat->load(['session', 'widget', 'category', 'visitor', 'handoffTicket']);

        // The newest page, oldest first; one row more than the page says whether older history exists.
        $rows = $chat->messages()->reorder('id', 'desc')->with('sentBy')->limit(self::MESSAGE_PAGE + 1)->get();
        $page = $rows->take(self::MESSAGE_PAGE)->reverse()->values();
        $messages = $page->map(function (WaMessage $message) use ($chat, $urls): array {
            $message->setRelation('chat', $chat);

            return WaMessageData::fromModel($message, $urls)->toArray();
        })->all();

        return Inertia::render('whatsapp/inbox', [
            ...$this->shell(),
            'selected' => [
                'detail' => WaChatDetailData::fromModel($chat)->toArray(),
                'messages' => $messages,
                // `prev_cursor` is the `before_id` of the previous page: the oldest message of this one, when there is older history.
                'meta' => [
                    'next_cursor' => null,
                    'prev_cursor' => $rows->count() > self::MESSAGE_PAGE ? ($messages[0]['ulid'] ?? null) : null,
                ],
            ],
        ]);
    }

    /** The URL the first sketches of this page used (`/whatsapp/{chat}`): it keeps working. */
    public function legacy(WaChat $chat): RedirectResponse
    {
        return redirect()->route('whatsapp.chats.show', ['chat' => $chat->ulid]);
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
            'sessions' => WhatsAppSession::query()->withCount('widgets')->orderBy('name')->get()
                ->map(fn (WhatsAppSession $session): array => WhatsAppSessionData::fromModel($session)->toArray())->values()->all(),
            'chats' => $rows->take(self::CHAT_PAGE)
                ->map(fn (WaChat $chat): array => WaChatData::fromModel($chat)->toArray())->values()->all(),
            // The cursor "load more" continues from is the API's (opaque): the page only says that there is more, and the client reads the first
            // page once to learn it.
            'meta' => [
                'next_cursor' => null,
                'has_more' => $rows->count() > self::CHAT_PAGE,
                'unread_chats' => WaChat::query()->open()->where('unread_by_admin', '>', 0)->count(),
            ],
            'widgets' => Widget::query()->orderBy('name')->get()
                ->map(fn (Widget $widget): array => WidgetRefData::fromModel($widget)->toArray())->values()->all(),
            'categories' => Category::query()->orderBy('name')->get()
                ->map(fn (Category $category): array => CategoryRefData::fromModel($category)->toArray())->values()->all(),
            'whatsappEnabled' => settings()->bool('whatsapp.enabled', false),
            'replyOnlyToInbound' => settings()->bool('whatsapp.reply_only_to_inbound', true),
        ];
    }
}
