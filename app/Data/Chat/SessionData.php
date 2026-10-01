<?php

namespace App\Data\Chat;

use App\Domain\Visitors\StartedSession;
use App\Domain\Widgets\Support\Timestamps;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The answer of `POST /public/widgets/{key}/sessions` (inside `{ data }`): the plaintext token (shown once), when it expires, the
 * open chat that was resumed (or null), the websocket endpoint (null when Reverb is not configured: the panel stays on REST) and
 * the limits the panel checks client-side before it sends anything.
 */
#[TypeScript]
class SessionData extends Data
{
    public function __construct(
        public string $visitorToken,
        public string $expiresAt,
        public ?ConversationPublicData $conversation,
        public ?RealtimeEndpointData $ws,
        public SessionLimitsData $limits,
    ) {}

    public static function fromStarted(StartedSession $started, ?RealtimeEndpointData $ws): self
    {
        return new self(
            visitorToken: $started->token->plaintext,
            expiresAt: (string) Timestamps::iso($started->token->session->expires_at),
            conversation: $started->conversation === null ? null : ConversationPublicData::fromModel($started->conversation),
            ws: $ws,
            limits: SessionLimitsData::current(),
        );
    }
}
