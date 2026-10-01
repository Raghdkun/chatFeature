<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ChatStartGuard;
use App\Domain\Chat\Services\ConversationCreator;
use App\Domain\Chat\Services\ConversationMessenger;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Chat\Services\MessageText;
use App\Domain\Chat\Services\PreChatRules;
use App\Domain\Chat\Services\RoutingPlan;
use App\Domain\Presence\AvailableAgents;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use App\Support\Database\DeadlockRetry;
use Carbon\CarbonImmutable;
use Illuminate\Validation\ValidationException;

/**
 * A visitor starts a live chat (`POST /public/conversations`).
 *
 * The widget's pre-chat rules were validated by the request (`PreChatRules`); here the server decides whether the chat can be
 * taken at all: the category must be active and enabled on the widget, the widget must be open and some agent must be
 * available for it (`409 no_agents` = offer the offline form), and the session may have only one open live chat (P4-D3: the
 * session row is locked and the check repeats inside the transaction, `409 conversation_exists`). The chat is queued and wave
 * 1 of the routing runs in the same transaction. Anti-automation (`ChatStartGuard`): a cooldown after a cancelled chat and a cap on
 * chats queued from one network answer `429 rate_limited`.
 */
final class StartConversation
{
    public function __construct(
        private readonly AvailabilityService $availability,
        private readonly AvailableAgents $agents,
        private readonly PreChatRules $preChat,
        private readonly OfferToAgents $offers,
        private readonly ConversationCreator $creator,
        private readonly ConversationMessenger $messenger,
        private readonly ConversationTimeline $timeline,
        private readonly ChatStartGuard $guard,
    ) {}

    /**
     * @param  array{category: string, name?: string|null, email?: string|null, phone?: string|null, message?: string|null, consent?: bool|null}  $input
     */
    public function handle(VisitorSession $session, array $input): Conversation
    {
        $widget = $session->widget;
        $category = $this->category($widget, $input['category']);

        if ($this->hasOpenLiveChat($session)) {
            throw $this->exists();
        }

        $this->guard->assertNotCoolingDown($session->visitor_id);

        $plan = RoutingPlan::forWidget($widget);

        if (! $this->availability->isOpenAt($widget, CarbonImmutable::now()) || ! $this->agents->exists($category->id, $plan->allStatuses())) {
            throw new ApiProblemException(409, 'no_agents', __('No agent is available right now.'));
        }

        $conversation = DeadlockRetry::transaction(function () use ($session, $widget, $category, $input): Conversation {
            $locked = VisitorSession::query()->whereKey($session->id)->lockForUpdate()->first();

            if ($locked === null || ! $locked->isActive()) {
                throw ApiProblemException::unauthorized('session_revoked', __('This chat session has ended. Please start a new one.'));
            }

            if ($this->hasOpenLiveChat($session)) {
                throw $this->exists();
            }

            $this->guard->assertNetworkHasRoom($locked);

            $visitor = $this->updateVisitor($session->visitor_id, $widget, $input);
            $now = now();

            $conversation = $this->creator->create([
                'workspace_id' => $widget->workspace_id,
                'widget_id' => $widget->id,
                'visitor_id' => $visitor->id,
                'visitor_session_id' => $session->id,
                'category_id' => $category->id,
                'type' => ConversationType::Live->value,
                'status' => ConversationStatus::Queued->value,
                'queued_at' => $now,
                'queue_expires_at' => $now->addSeconds(max(1, (int) $widget->queue_timeout_seconds)),
                'last_activity_at' => $now,
            ]);
            $conversation->setRelation('widget', $widget);
            $conversation->setRelation('category', $category);
            $conversation->setRelation('visitor', $visitor);

            $first = MessageText::clean($input['message'] ?? null);

            if ($first !== null) {
                $this->messenger->append($conversation, SenderType::Visitor, MessageType::Text, $first);
            }

            $this->timeline->record($conversation, ConversationTimeline::CREATED, ActorType::Visitor, $visitor->id, array_filter([
                'category' => $category->slug,
                'widget' => $widget->ulid,
                'consent' => ($input['consent'] ?? null) === true ? true : null,
            ], static fn (mixed $value): bool => $value !== null));
            $this->offers->start($conversation);

            return $conversation;
        });

        ConversationQueued::dispatch($conversation);
        QueueChanged::dispatch($conversation);

        return $conversation->load(['category', 'assignedAgent']);
    }

    private function category(Widget $widget, string $slug): Category
    {
        $category = $widget->categories()->where('categories.is_active', true)->where('categories.slug', $slug)->first();

        if ($category === null) {
            throw ValidationException::withMessages(['category' => [__('This topic is not available.')]]);
        }

        return $category;
    }

    private function hasOpenLiveChat(VisitorSession $session): bool
    {
        return Conversation::query()
            ->where('visitor_session_id', $session->id)
            ->where('type', ConversationType::Live->value)
            ->whereIn('status', ConversationStatus::openValues())
            ->exists();
    }

    private function exists(): ApiProblemException
    {
        return ApiProblemException::conflict('conversation_exists', __('You already have an open chat.'));
    }

    /**
     * Take the pre-chat answers the widget asks for into the visitor's record; what a verified identity vouched for stays.
     *
     * @param  array<string, mixed>  $input
     */
    private function updateVisitor(int $visitorId, Widget $widget, array $input): Visitor
    {
        $visitor = Visitor::query()->lockForUpdate()->findOrFail($visitorId);

        foreach ($this->preChat->collectedFields($widget) as $field) {
            $value = $input[$field] ?? null;

            if (is_string($value) && trim($value) !== '' && (! $visitor->verified || blank($visitor->{$field}))) {
                $visitor->{$field} = trim($value);
            }
        }

        $visitor->forceFill(['last_seen_at' => now()])->save();

        return $visitor;
    }
}
