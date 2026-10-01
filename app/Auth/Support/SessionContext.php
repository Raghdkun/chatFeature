<?php

namespace App\Auth\Support;

use App\Models\User;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * What a driver needs to judge a session: which session, from where. P2 adds fields additively:
 * `externalSessionId` (the portal session bound to this browser session) and `sanctumTokenId`
 * (the bearer token of a mobile/API request).
 */
final readonly class SessionContext
{
    /** Session key under which a signed-in browser session carries its `external_sessions` id (mode 2). */
    public const EXTERNAL_SESSION_KEY = 'auth.external_session';

    public function __construct(
        public ?string $sessionId = null,
        public ?string $ip = null,
        public ?string $userAgent = null,
        public ?string $externalSessionId = null,
        public ?int $sanctumTokenId = null,
    ) {}

    public static function fromRequest(Request $request): self
    {
        $bound = $request->hasSession() ? $request->session()->get(self::EXTERNAL_SESSION_KEY) : null;
        $user = $request->user();
        $token = $user instanceof User ? $user->currentAccessToken() : null;

        return new self(
            $request->hasSession() ? $request->session()->getId() : null,
            $request->ip(),
            $request->userAgent(),
            is_string($bound) && $bound !== '' ? $bound : null,
            $token instanceof PersonalAccessToken ? (int) $token->getKey() : null,
        );
    }
}
