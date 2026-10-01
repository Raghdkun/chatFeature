<?php

namespace App\Auth\Support;

use Illuminate\Http\Request;

/** What a driver needs to judge a session: which session, from where. P2 adds fields additively. */
final readonly class SessionContext
{
    public function __construct(
        public ?string $sessionId = null,
        public ?string $ip = null,
        public ?string $userAgent = null,
    ) {}

    public static function fromRequest(Request $request): self
    {
        return new self(
            $request->hasSession() ? $request->session()->getId() : null,
            $request->ip(),
            $request->userAgent(),
        );
    }
}
