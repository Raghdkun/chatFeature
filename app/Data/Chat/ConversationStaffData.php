<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Conversation;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A conversation as staff see it (`ConversationStaff` = `ConversationPublic` + the extras below): visitor details, widget,
 * assignee, unseen counter and timing. Staff-facing only. Every `ConversationPublicData` key is repeated with the same value
 * (the JSON is flat); eager-load `category`, `assignedAgent`, `visitor`, `visitorSession` and `widget`. `queueExpiresAt` lets a reloaded queue snapshot count down; `pageUrl` / `pageTitle` are the page the visitor was on when the session started (as the host page reported it).
 */
#[TypeScript]
class ConversationStaffData extends Data
{
    public function __construct(
        public string $ulid,
        public string $ticketNo,
        public ConversationStatus $status,
        public ConversationType $type,
        public ?CategoryRefData $category,
        public ?AgentRefData $agent,
        public string $createdAt,
        public ?string $endedAt,
        public bool $ratingRequested,
        public int $lastSeq,
        public VisitorSummaryData $visitor,
        public WidgetRefData $widget,
        public ?StaffAgentRefData $assignedAgent,
        public int $unseenByAgent,
        public ?string $claimedAt,
        public ?string $lastMessageAt,
        public ?string $lastMessagePreview,
        public ?string $queueExpiresAt,
        public ?string $pageUrl,
        public ?string $pageTitle,
    ) {}

    public static function fromModel(Conversation $conversation): self
    {
        $public = ConversationPublicData::fromModel($conversation);

        return new self(
            ulid: $public->ulid,
            ticketNo: $public->ticketNo,
            status: $public->status,
            type: $public->type,
            category: $public->category,
            agent: $public->agent,
            createdAt: $public->createdAt,
            endedAt: $public->endedAt,
            ratingRequested: $public->ratingRequested,
            lastSeq: $public->lastSeq,
            visitor: VisitorSummaryData::fromModel($conversation->visitor),
            widget: WidgetRefData::fromModel($conversation->widget),
            assignedAgent: $conversation->assignedAgent === null ? null : StaffAgentRefData::fromModel($conversation->assignedAgent),
            unseenByAgent: $conversation->unseen_by_agent,
            claimedAt: Timestamps::iso($conversation->claimed_at),
            lastMessageAt: Timestamps::iso($conversation->last_message_at),
            lastMessagePreview: $conversation->last_message_preview,
            queueExpiresAt: Timestamps::iso($conversation->queue_expires_at),
            pageUrl: $conversation->visitorSession?->page_url,
            pageTitle: $conversation->visitorSession?->page_title,
        );
    }
}
