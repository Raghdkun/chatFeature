<?php

namespace App\Http\Controllers\Dashboard;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Http\Controllers\Controller;
use App\Http\Controllers\Dashboard\Concerns\PresentsConversations;
use App\Models\Conversation;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `offline-tickets/index` (any staff): offline tickets that are still open (`queued` = unclaimed, `active` = claimed),
 * limited by `Conversation::visibleTo()` (an agent sees the unclaimed tickets of the categories they serve and the ones they claimed).
 */
class OfflineTicketsPageController extends Controller
{
    use PresentsConversations;

    private const LIST_LIMIT = 200;

    public function index(Request $request): Response
    {
        $tickets = $this->withStaffRelations(Conversation::query()->visibleTo($request->user()))
            ->where('type', ConversationType::Offline->value)
            ->whereIn('status', [ConversationStatus::Queued->value, ConversationStatus::Active->value])
            ->orderBy('created_at')
            ->orderBy('id')
            ->limit(self::LIST_LIMIT)
            ->get();

        return Inertia::render('offline-tickets/index', [
            'tickets' => $this->staffRows($tickets),
        ]);
    }
}
