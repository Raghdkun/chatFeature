<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\Catalog\CategoryData;
use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\MessageData;
use App\Domain\Catalog\Support\CategoryQuery;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Http\Controllers\Controller;
use App\Http\Controllers\Dashboard\Concerns\PresentsConversations;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia pages `inbox/index` and `inbox/show` (any staff). The lists start from `Conversation::visibleTo($user)`, so an agent only
 * ever receives the chats offered or assigned to them (admins: everything); a single conversation is authorised with the policy
 * (`403` for an agent that is not on it). Everything after the first paint arrives over the management API and the websocket.
 */
class InboxPageController extends Controller
{
    use PresentsConversations;

    /** How many rows each list carries (the live lists are short; this only bounds a pathological backlog). */
    private const LIST_LIMIT = 200;

    /** A finished chat stays in "My chats" this long so the agent can still look at it. */
    private const RECENTLY_CLOSED_HOURS = 12;

    public function index(Request $request, CategoryQuery $categories): Response
    {
        return Inertia::render('inbox/index', $this->shell($request->user(), $categories));
    }

    public function show(Request $request, Conversation $conversation, CategoryQuery $categories): Response
    {
        $user = $request->user();

        Gate::forUser($user)->authorize('view', $conversation);

        $conversation->load(['category', 'assignedAgent', 'visitor', 'widget']);

        return Inertia::render('inbox/show', [
            ...$this->shell($user, $categories),
            'conversation' => ConversationStaffData::fromModel($conversation)->toArray(),
            'messages' => $this->messages($conversation),
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function shell(User $user, CategoryQuery $categories): array
    {
        return [
            'queue' => $this->queue($user),
            'mine' => $this->mine($user),
            'presence' => ['status' => $user->presence?->status->value ?? 'offline'],
            'categories' => $categories->all(onlyActive: ! $user->is_admin)
                ->map(fn (Category $category): array => CategoryData::fromCategory($category)->toArray())
                ->values()
                ->all(),
        ];
    }

    /**
     * Live chats waiting for an agent: offered to the agent (or all of them for an admin), oldest first.
     *
     * @return array<int, array<string, mixed>>
     */
    private function queue(User $user): array
    {
        $rows = $this->withStaffRelations(Conversation::query()->visibleTo($user))
            ->where('type', ConversationType::Live->value)
            ->where('status', ConversationStatus::Queued->value)
            ->orderBy('queued_at')
            ->orderBy('id')
            ->limit(self::LIST_LIMIT)
            ->get();

        return $this->staffRows($rows);
    }

    /**
     * Live chats being worked on (and the ones finished a moment ago), most recent activity first. For an admin this is every
     * agent's chat; the page groups the ones assigned to someone else as "monitoring".
     *
     * @return array<int, array<string, mixed>>
     */
    private function mine(User $user): array
    {
        $rows = $this->withStaffRelations(Conversation::query()->visibleTo($user))
            ->where('type', ConversationType::Live->value)
            ->where(function ($status): void {
                $status->whereIn('status', [ConversationStatus::Active->value, ConversationStatus::Ended->value])
                    ->orWhere(function ($closed): void {
                        $closed->where('status', ConversationStatus::Closed->value)
                            ->where('closed_at', '>=', now()->subHours(self::RECENTLY_CLOSED_HOURS));
                    });
            })
            ->orderByDesc('last_activity_at')
            ->orderByDesc('id')
            ->limit(self::LIST_LIMIT)
            ->get();

        return $this->staffRows($rows);
    }

    /**
     * The whole conversation, oldest first: the client numbers gaps by `seq`, so a partial list would look like missing messages.
     *
     * @return array<int, array<string, mixed>>
     */
    private function messages(Conversation $conversation): array
    {
        return $conversation->messages()
            ->with(['senderUser', 'attachments'])
            ->get()
            ->map(function (Message $message) use ($conversation): array {
                $message->setRelation('conversation', $conversation);

                return MessageData::fromModel($message, forStaff: true)->toArray();
            })
            ->values()
            ->all();
    }
}
