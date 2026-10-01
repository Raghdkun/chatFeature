<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ConversationCreator;
use App\Domain\Chat\Services\ConversationMessenger;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Chat\Services\MessageText;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use App\Support\Database\DeadlockRetry;
use Illuminate\Validation\ValidationException;

/**
 * The offline form (`POST /public/offline-tickets`, decision P4-D2): a visitor leaves a message when nobody is available, either
 * right after `409 no_agents` or after their live chat went `missed`. It is a NEW conversation row (`type = offline`,
 * `status = queued`, no queue timeout); the link to a missed chat is recorded in the `created` event. Staff answer it by
 * claiming it and replying; the reply is e-mailed to the address given here.
 */
final class CreateOfflineTicket
{
    public function __construct(
        private readonly WidgetConfigValidator $configs,
        private readonly ConversationCreator $creator,
        private readonly ConversationMessenger $messenger,
        private readonly ConversationTimeline $timeline,
    ) {}

    /**
     * @param  array{name: string, email: string, message: string, category?: string|null, missed_conversation?: string|null}  $input
     */
    public function handle(VisitorSession $session, array $input): Conversation
    {
        $widget = $session->widget;

        if (! $this->configs->hydrate($widget->config)->features->offlineForm) {
            throw ApiProblemException::forbidden('feature_disabled', __('This widget does not take offline messages.'));
        }

        $missed = $this->missedConversation($session, $input['missed_conversation'] ?? null);
        $category = $this->category($widget, $input['category'] ?? null, $missed);
        $body = MessageText::clean($input['message']);

        if ($body === null) {
            throw ValidationException::withMessages(['message' => [__('Please write a message.')]]);
        }

        $conversation = DeadlockRetry::transaction(function () use ($session, $widget, $category, $missed, $input, $body): Conversation {
            $visitor = $this->updateVisitor($session->visitor_id, $input);
            $now = now();

            $conversation = $this->creator->create([
                'workspace_id' => $widget->workspace_id,
                'widget_id' => $widget->id,
                'visitor_id' => $visitor->id,
                'visitor_session_id' => $session->id,
                'category_id' => $category?->id,
                'type' => ConversationType::Offline->value,
                'status' => ConversationStatus::Queued->value,
                'queued_at' => $now,
                'last_activity_at' => $now,
            ]);
            $conversation->setRelation('widget', $widget);
            $conversation->setRelation('visitor', $visitor);

            $this->messenger->append($conversation, SenderType::Visitor, MessageType::Text, $body);
            $this->timeline->record($conversation, ConversationTimeline::CREATED, ActorType::Visitor, $visitor->id, [
                'origin' => $missed?->ulid,
                'category' => $category?->slug,
                'widget' => $widget->ulid,
            ]);

            return $conversation;
        });

        $conversation->load(['category', 'assignedAgent', 'visitor', 'widget']);

        OfflineTicketCreated::dispatch($conversation);
        QueueChanged::dispatch($conversation);

        return $conversation;
    }

    /** The visitor's own `missed` live chat the ticket follows up on, if they named one. */
    private function missedConversation(VisitorSession $session, ?string $ulid): ?Conversation
    {
        if ($ulid === null || $ulid === '') {
            return null;
        }

        $conversation = Conversation::query()
            ->where('ulid', $ulid)
            ->where('visitor_session_id', $session->id)
            ->where('visitor_id', $session->visitor_id)
            ->where('type', ConversationType::Live->value)
            ->where('status', ConversationStatus::Missed->value)
            ->first();

        if ($conversation === null) {
            throw ValidationException::withMessages(['missed_conversation' => [__('That chat cannot be continued by message.')]]);
        }

        return $conversation;
    }

    private function category(Widget $widget, ?string $slug, ?Conversation $missed): ?Category
    {
        if ($slug === null || $slug === '') {
            return $missed?->category;
        }

        $category = $widget->categories()->where('categories.is_active', true)->where('categories.slug', $slug)->first();

        if ($category === null) {
            throw ValidationException::withMessages(['category' => [__('This topic is not available.')]]);
        }

        return $category;
    }

    /**
     * The name and e-mail of the form go on the visitor's record (a verified identity keeps what it vouched for).
     *
     * @param  array<string, mixed>  $input
     */
    private function updateVisitor(int $visitorId, array $input): Visitor
    {
        $visitor = Visitor::query()->lockForUpdate()->findOrFail($visitorId);

        foreach (['name', 'email'] as $field) {
            $value = $input[$field] ?? null;

            if (is_string($value) && trim($value) !== '' && (! $visitor->verified || blank($visitor->{$field}))) {
                $visitor->{$field} = trim($value);
            }
        }

        $visitor->forceFill(['last_seen_at' => now()])->save();

        return $visitor;
    }
}
