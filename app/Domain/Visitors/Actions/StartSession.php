<?php

namespace App\Domain\Visitors\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Visitors\Events\VisitorSessionsEnded;
use App\Domain\Visitors\StartedSession;
use App\Domain\Visitors\VisitorTokenService;
use App\Domain\Widgets\Identity\IdentityTokenVerifier;
use App\Domain\Widgets\Identity\VerifiedIdentity;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Models\Conversation;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use App\Support\Database\DeadlockRetry;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Validation\ValidationException;

/**
 * `POST /public/widgets/{key}/sessions`: a browser opens the chat panel and gets a visitor token.
 *
 * - A signed identity (`identity_token`, HS256, verified by `IdentityTokenVerifier`) makes the visitor **verified**: the claims are
 *   authoritative and a verified visitor is keyed by `external_id` (the token's `sub`), so the same person is one `Visitor` across
 *   browsers. A token that does not verify is a `422` (never silently downgraded to anonymous). Unsigned `visitor` data is stored
 *   as given, marked unverified.
 * - A returning bearer token (an active session of this widget) is rotated: the visitor is kept and a new token is issued. The
 *   previous token is not revoked at once (a second tab may still be mid-request) but its expiry is capped to `OVERLAP_SECONDS`
 *   from now, in the same transaction, and never extended again: after that window it is `401 session_revoked`, so a stale or
 *   stolen token cannot outlive a rotation (nor take over the open chat by rotating itself). A previous verified visitor is only
 *   continued with a fresh identity proof.
 * - Only a still-open live chat (`queued` / `active`) is resumed: it moves to the new session, so a chat is never reachable from two
 *   tokens (a session that held it and is not the token being rotated is revoked at once; the rotated token keeps only its overlap
 *   window). Everything else starts clean (a new visit is a new ticket).
 */
final class StartSession
{
    /** How long the previous token of a rotation keeps working (multi-tab races), counted from the rotation. */
    public const OVERLAP_SECONDS = 60;

    /** Unverified `meta` a visitor can pile up across sessions: at most this many keys and this many serialised bytes. */
    public const META_MAX_KEYS = 20;

    public const META_MAX_BYTES = 8192;

    public function __construct(
        private readonly IdentityTokenVerifier $identities,
        private readonly VisitorTokenService $tokens,
    ) {}

    /**
     * @param  array<string, mixed>  $input  `identity_token`, `visitor{name,email,phone,meta}`, `page{url,title,referrer}`, `locale`
     */
    public function handle(Widget $widget, array $input, ?string $bearerToken, ?string $userAgent, ?string $ip = null): StartedSession
    {
        $identity = $this->identity($widget, $input['identity_token'] ?? null);
        $previous = $this->previousSession($widget, $bearerToken);

        // A verified visitor is looked up with `lockForUpdate` on a key that may not exist yet (a gap lock) and then inserted: two
        // first sessions of different identities in the same index range deadlock (MySQL 1213) and one is the victim: run it again.
        $started = DeadlockRetry::transaction(function () use ($widget, $input, $identity, $previous, $userAgent, $ip): StartedSession {
            $visitor = $this->visitor($widget, $identity, $previous, (array) ($input['visitor'] ?? []));
            $page = (array) ($input['page'] ?? []);

            $issued = $this->tokens->issue($visitor, [
                'page_url' => $this->string($page['url'] ?? null),
                'page_title' => $this->string($page['title'] ?? null),
                'referrer' => $this->string($page['referrer'] ?? null),
                'user_agent' => $userAgent,
                'locale' => $this->string($input['locale'] ?? null),
                'network_hash' => $ip === null ? null : ClientNetwork::fingerprint($ip),
            ]);

            if ($previous !== null) {
                $this->capOverlap($previous);
            }

            return new StartedSession($issued, $this->resume($visitor, $issued->session, $previous));
        });

        return $started;
    }

    /** Shortens (never extends) the previous token's life to the overlap window. */
    private function capOverlap(VisitorSession $previous): void
    {
        $cap = now()->addSeconds(self::OVERLAP_SECONDS);

        VisitorSession::query()
            ->whereKey($previous->id)
            ->whereNull('revoked_at')
            ->where('expires_at', '>', $cap)
            ->update(['expires_at' => $cap]);

        // Its chat (if it had one) moves to the new token in this same transaction, so this token's websocket has nothing left to listen to.
        VisitorSessionsEnded::dispatch([$previous->id], 'rotated');
    }

    private function identity(Widget $widget, mixed $token): ?VerifiedIdentity
    {
        if (! is_string($token) || $token === '') {
            return null;
        }

        $result = $this->identities->verifyForWidget($token, $widget);

        if ($result->identity === null) {
            throw ValidationException::withMessages(['identity_token' => [__('The identity could not be verified.')]]);
        }

        return $result->identity;
    }

    private function previousSession(Widget $widget, ?string $bearerToken): ?VisitorSession
    {
        if ($bearerToken === null || $bearerToken === '') {
            return null;
        }

        $session = $this->tokens->find($bearerToken);

        return $session !== null && $session->isActive() && $session->widget_id === $widget->id ? $session : null;
    }

    /**
     * @param  array<string, mixed>  $submitted
     */
    private function visitor(Widget $widget, ?VerifiedIdentity $identity, ?VisitorSession $previous, array $submitted): Visitor
    {
        if ($identity !== null && $identity->subject !== null) {
            return $this->verifiedVisitor($widget, $identity);
        }

        if ($identity !== null) {
            return $this->fill(new Visitor(['widget_id' => $widget->id, 'verified' => true]), $identity->toArray(), true);
        }

        $reusable = $previous?->visitor;

        if ($reusable !== null && ! $reusable->verified) {
            return $this->fill($reusable, $submitted, false);
        }

        return $this->fill(new Visitor(['widget_id' => $widget->id, 'verified' => false]), $submitted, false);
    }

    private function verifiedVisitor(Widget $widget, VerifiedIdentity $identity): Visitor
    {
        for ($attempt = 1; ; $attempt++) {
            $visitor = Visitor::query()
                ->where('widget_id', $widget->id)
                ->where('external_id', $identity->subject)
                ->lockForUpdate()
                ->first() ?? new Visitor(['widget_id' => $widget->id, 'external_id' => $identity->subject]);

            $visitor->verified = true;

            try {
                return $this->fill($visitor, $identity->toArray(), true);
            } catch (UniqueConstraintViolationException $exception) {
                // Two sessions of a new identity raced for the one row: the winner's row is read on the next round.
                if ($attempt >= 2) {
                    throw $exception;
                }
            }
        }
    }

    /**
     * Copy the offered fields onto the visitor and save it. Verified: identity claims replace what is stored (only the ones the
     * token carries). Unverified: whatever was submitted, nothing else.
     *
     * @param  array<string, mixed>  $data
     */
    private function fill(Visitor $visitor, array $data, bool $verified): Visitor
    {
        foreach (['name', 'email', 'phone'] as $field) {
            $value = $data[$field] ?? null;

            if (is_string($value) && trim($value) !== '') {
                $visitor->{$field} = trim($value);
            }
        }

        $meta = $data['meta'] ?? null;

        if (is_array($meta) && $meta !== []) {
            $visitor->meta = $verified ? $meta : $this->mergeMeta($meta, (array) $visitor->meta);
        }

        $visitor->forceFill(['first_seen_at' => $visitor->first_seen_at ?? now(), 'last_seen_at' => now()])->save();

        return $visitor;
    }

    /**
     * Unverified meta from every visit accumulates on the one visitor row: the newest keys win and the oldest are dropped past
     * `META_MAX_KEYS` keys or `META_MAX_BYTES` serialised bytes.
     *
     * @param  array<string, mixed>  $submitted
     * @param  array<string, mixed>  $stored
     * @return array<string, mixed>
     */
    private function mergeMeta(array $submitted, array $stored): array
    {
        $merged = array_slice($submitted + $stored, 0, self::META_MAX_KEYS, true);

        while ($merged !== [] && strlen((string) json_encode($merged, JSON_UNESCAPED_UNICODE)) > self::META_MAX_BYTES) {
            array_pop($merged);
        }

        return $merged;
    }

    /**
     * The visitor's open live chat moves to the new session. The session that held it is revoked at once, unless it is the token
     * this very rotation replaces: that one only gets the overlap window (already applied), like every previous token. It cannot
     * reach the chat any more either way (`VisitorSession::owns` follows `visitor_session_id`).
     */
    private function resume(Visitor $visitor, VisitorSession $session, ?VisitorSession $previous): ?Conversation
    {
        $conversation = Conversation::query()
            ->where('visitor_id', $visitor->id)
            ->where('type', ConversationType::Live->value)
            ->whereIn('status', ConversationStatus::openValues())
            ->orderByDesc('id')
            ->lockForUpdate()
            ->first();

        if ($conversation === null) {
            return null;
        }

        $holder = $conversation->visitor_session_id === null ? null : VisitorSession::query()->find($conversation->visitor_session_id);

        $conversation->visitor_session_id = $session->id;
        $conversation->save();

        if ($holder !== null && $holder->id !== $previous?->id) {
            $this->tokens->revoke($holder);
        }

        return $conversation->load(['category', 'assignedAgent']);
    }

    private function string(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : null;
    }
}
