<?php

namespace App\Http\Controllers\WhatsApp;

use App\Data\Chat\CategoryRefData;
use App\Data\Chat\WidgetRefData;
use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Data\WhatsApp\WhatsAppSettingsData;
use App\Data\WhatsApp\WidgetWhatsAppLinkData;
use App\Domain\WhatsApp\Queries\WaChatCursor;
use App\Domain\WhatsApp\Queries\WaChatListQuery;
use App\Domain\WhatsApp\Queries\WaMessagePage;
use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use App\Support\Network\OutboundUrlGuard;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The WhatsApp Inertia pages (administrators only: `wa.admin` on the route, the policy asked again here): the inbox (`whatsapp/inbox`,
 * with a chat selected on `whatsapp/chats/{chat}`) and Settings > WhatsApp (`settings/whatsapp`). Props are the Data classes of
 * `app/Data/WhatsApp`; after the first paint everything goes through the management API and the `private-whatsapp-admin` channel. Nothing
 * here is ever shared with an agent: an agent never gets past the middleware.
 */
class WhatsAppPageController extends Controller
{
    /** Rows of the first page of the inbox. */
    private const FIRST_PAGE = 50;

    /** Messages of the transcript on first paint. */
    private const FIRST_MESSAGES = 100;

    public function inbox(Request $request, WaChatListQuery $chats): Response
    {
        Gate::forUser($request->user())->authorize('viewAny', WaChat::class);

        return Inertia::render('whatsapp/inbox', [...$this->shell($chats), 'selected' => null]);
    }

    public function show(Request $request, WaChat $chat, WaChatListQuery $chats, WaMessagePage $pages): Response
    {
        Gate::forUser($request->user())->authorize('view', $chat);

        $chat->load(['session', 'widget', 'category', 'visitor', 'handoffTicket']);
        $page = $pages->fetch($chat, null, null, self::FIRST_MESSAGES);

        return Inertia::render('whatsapp/inbox', [
            ...$this->shell($chats),
            'selected' => [
                'detail' => WaChatDetailData::fromModel($chat)->toArray(),
                'messages' => array_map(fn (WaMessage $message): array => WaMessageData::fromModel($message)->toArray(), $page['messages']),
                'meta' => ['next_cursor' => $page['next_cursor'], 'prev_cursor' => $page['prev_cursor']],
            ],
        ]);
    }

    public function settings(Request $request): Response
    {
        Gate::forUser($request->user())->authorize('manageSettings', WhatsAppSession::class);

        return Inertia::render('settings/whatsapp', [
            'settings' => WhatsAppSettingsData::fromSettings()->toArray(),
            'sessions' => $this->sessions(),
            'widgets' => Widget::query()->with('whatsappSession')->orderBy('name')->orderBy('id')->get()
                ->map(fn (Widget $widget): array => WidgetWhatsAppLinkData::fromWidget($widget)->toArray())->values()->all(),
            'privateHostsAllowed' => app(OutboundUrlGuard::class)->allowsPrivateHosts(),
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function shell(WaChatListQuery $chats): array
    {
        $rows = $chats->ordered($chats->build([]), null)->with(['session', 'widget', 'category'])->limit(self::FIRST_PAGE + 1)->get();
        $page = $rows->take(self::FIRST_PAGE)->values();

        return [
            'sessions' => $this->sessions(),
            'chats' => $page->map(fn (WaChat $chat): array => WaChatData::fromModel($chat)->toArray())->all(),
            'meta' => [
                'next_cursor' => $rows->count() > self::FIRST_PAGE && $page->isNotEmpty() ? WaChatCursor::after($page->last())->encode() : null,
                'unread_chats' => $chats->unreadChats(),
            ],
            'widgets' => Widget::query()->orderBy('name')->orderBy('id')->get()->map(fn (Widget $widget): array => WidgetRefData::fromModel($widget)->toArray())->all(),
            'categories' => Category::query()->orderBy('sort_order')->orderBy('name')->get()->map(fn (Category $category): array => CategoryRefData::fromModel($category)->toArray())->all(),
            'whatsappEnabled' => settings()->bool('whatsapp.enabled', false),
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function sessions(): array
    {
        return WhatsAppSession::query()->withCount('widgets')->orderBy('id')->get()
            ->map(fn (WhatsAppSession $session): array => WhatsAppSessionData::fromModel($session)->toArray())->values()->all();
    }
}
