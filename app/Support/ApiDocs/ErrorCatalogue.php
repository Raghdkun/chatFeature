<?php

namespace App\Support\ApiDocs;

use InvalidArgumentException;

/**
 * Every machine-readable error code the API can answer with: its HTTP status, an example message, what it means and the `details`
 * it carries. The reference builds its error examples from this table and the rot guard (`ApiDocsGuardTest`) pins it to the codes
 * the application code actually raises, in both directions. Messages are human text for people: clients branch on `error.code`,
 * never on the message.
 *
 * @phpstan-type ErrorSpec array{status: int, message: string, meaning: string, details?: array<string, mixed>, headers?: array<string, string>}
 */
final class ErrorCatalogue
{
    /**
     * @return array<string, ErrorSpec>
     */
    public static function all(): array
    {
        return [
            // Generic
            'validation_failed' => ['status' => 422, 'message' => 'The given data was invalid.', 'meaning' => 'The body or query did not pass validation. `details` is keyed by field name (nested fields use dots, `visitor.email`), each value a list of messages.', 'details' => ['email' => ['The email field must be a valid email address.']]],
            'unauthenticated' => ['status' => 401, 'message' => 'Authentication is required.', 'meaning' => 'No credential, or one the server does not know (an unknown, deleted or expired token).'],
            'session_revoked' => ['status' => 401, 'message' => 'Your session has ended. Please sign in again.', 'meaning' => 'The credential was valid but has ended: a deactivated account, a role that was removed, a session the auth portal revoked, a visitor token that expired or was rotated away. Drop the stored credential and sign in (or start a session) again.'],
            'forbidden' => ['status' => 403, 'message' => 'Only administrators can do this.', 'meaning' => 'The caller is authenticated but not allowed: not an administrator on an admin route, or not allowed to see this conversation.'],
            'no_chat_access' => ['status' => 403, 'message' => 'This account has no access to the chat dashboard. Ask an administrator to grant it.', 'meaning' => 'A valid account that is neither an administrator nor an agent.'],
            'not_found' => ['status' => 404, 'message' => 'Not found.', 'meaning' => 'The resource does not exist, or is not the caller\'s: another visitor\'s conversation and another user\'s device or token are 404, never 403, so their existence is not confirmed.'],
            'bad_request' => ['status' => 400, 'message' => 'Request failed.', 'meaning' => 'A malformed request that no more specific code describes.'],
            'method_not_allowed' => ['status' => 405, 'message' => 'The POST method is not supported for this route.', 'meaning' => 'The path exists but not for this HTTP method.'],
            'csrf_mismatch' => ['status' => 419, 'message' => 'CSRF token mismatch.', 'meaning' => 'A dashboard (cookie) call without a valid `X-XSRF-TOKEN`. Bearer-token clients never see it.'],
            'rate_limited' => ['status' => 429, 'message' => 'Too many requests.', 'meaning' => 'A rate limiter said stop. Wait `Retry-After` seconds (the header is always set; some answers also carry `details.retry_after`).', 'details' => ['retry_after' => 12], 'headers' => ['Retry-After' => '12']],
            'server_error' => ['status' => 500, 'message' => 'Something went wrong on our side.', 'meaning' => 'An unhandled exception. A production answer never contains details; retry later and report it with the time.'],
            'auth_mode_unavailable' => ['status' => 500, 'message' => 'The authentication mode is not configured. Run the setup again or contact the administrator.', 'meaning' => 'An installed instance without a valid `auth.mode` setting (fails closed).'],
            'auth_unavailable' => ['status' => 503, 'message' => 'The sign-in service (Auth Portal) is unreachable right now. You are still signed in; please try again in a few minutes.', 'meaning' => 'External auth mode only: the portal cannot be asked beyond the grace window. The session is kept; retry after `Retry-After` seconds.', 'headers' => ['Retry-After' => '30']],
            'conflict' => ['status' => 409, 'message' => 'Request failed.', 'meaning' => 'Generic fallback for a 409 without a specific code.'],
            'unavailable' => ['status' => 503, 'message' => 'Request failed.', 'meaning' => 'Generic fallback for a 503 without a specific code.'],

            // Public widget and visitor API
            'widget_not_found' => ['status' => 404, 'message' => 'This widget does not exist or is disabled.', 'meaning' => 'Unknown, deleted or disabled widget key (indistinguishable on purpose). Also answered by every visitor call once the token\'s widget was disabled or deleted.'],
            'origin_not_allowed' => ['status' => 403, 'message' => 'This website is not allowed to use the widget.', 'meaning' => 'The browser `Origin` is not on the widget\'s domain list, or there is no `Origin` and the widget does not allow non-browser clients. No CORS headers are sent.'],
            'feature_disabled' => ['status' => 403, 'message' => 'This chat cannot be ended by the visitor.', 'meaning' => 'The widget switched the feature the call needs off (`attachments`, `endChatByVisitor`, `offlineForm`, WhatsApp hand-off).'],
            'channel_forbidden' => ['status' => 403, 'message' => 'You cannot join this channel.', 'meaning' => 'Realtime channel authorisation refused: not this session\'s conversation channel (403, never 404: a Pusher client treats any non-200 as a refusal).'],
            'realtime_unavailable' => ['status' => 503, 'message' => 'Live updates are not available right now.', 'meaning' => 'Reverb is not the configured broadcaster: stay on REST polling (`GET .../messages?after_seq=`).'],
            'no_agents' => ['status' => 409, 'message' => 'No agent is available right now.', 'meaning' => 'Start chat: outside opening hours or nobody reachable serves the topic, so offer the offline form. Transfer: `details.target` (`agent`/`category`) and `details.reason` (`offline`, `at_capacity`, `no_reachable_agent`) say why; the agent keeps the chat.', 'details' => ['target' => 'agent', 'reason' => 'at_capacity']],
            'conversation_exists' => ['status' => 409, 'message' => 'You already have an open chat.', 'meaning' => 'A visitor has at most one open live chat, across all their sessions.'],
            'conversation_not_active' => ['status' => 409, 'message' => 'This chat is not active.', 'meaning' => 'The action needs an `active` live chat (a message to a queued or closed chat, typing, ending a chat that is not running).'],
            'conversation_not_queued' => ['status' => 409, 'message' => 'This chat is no longer waiting.', 'meaning' => 'Cancel or claim of a chat that is not `queued` any more (an agent was first, it was missed or closed).'],
            'conversation_not_ended' => ['status' => 409, 'message' => 'This chat has not ended yet.', 'meaning' => 'Rating or skipping before the chat reached `ended`.'],
            'conversation_not_open' => ['status' => 409, 'message' => 'This conversation is already closed.', 'meaning' => 'Closing a conversation that is already `closed`.'],
            'conversation_not_live' => ['status' => 409, 'message' => 'This action is only for live chats.', 'meaning' => 'A live-chat-only action (transfer targets) on an offline ticket.'],
            'already_rated' => ['status' => 409, 'message' => 'This chat was already rated.', 'meaning' => 'A conversation has one rating.'],
            'rating_window_closed' => ['status' => 409, 'message' => 'The time to rate this chat is over.', 'meaning' => 'Rating or skipping after `chat.rating_window_minutes`; the sweep closes the chat as `timeout`.'],
            'attachment_quota_exceeded' => ['status' => 422, 'message' => 'This chat already holds the maximum amount of images.', 'meaning' => 'The conversation\'s attachment bytes reached `chat.attachment_max_total_bytes`.', 'details' => ['file' => ['This chat already holds the maximum amount of images.']]],
            'whatsapp_unavailable' => ['status' => 409, 'message' => 'WhatsApp is not available right now.', 'meaning' => 'Hand-off: no `ready` WhatsApp session is linked to the widget.'],

            // Staff conversations, directory, notifications
            'already_claimed' => ['status' => 409, 'message' => 'Another agent already accepted this chat.', 'meaning' => 'The claim lost the race. `details.by` is the winner\'s display name (a plain string).', 'details' => ['by' => 'Sam Rivera']],
            'at_capacity' => ['status' => 409, 'message' => 'You are already handling the maximum number of chats.', 'meaning' => 'Claim by an agent at `max_concurrent_chats` (live chats only; offline tickets take no slot).'],
            'category_in_use' => ['status' => 409, 'message' => 'This category is used by a waiting or running conversation.', 'meaning' => 'Deleting a category that a queued or active conversation uses.'],
            'slug_taken' => ['status' => 409, 'message' => 'This slug is already used by another category.', 'meaning' => 'Category slug already in use (also when lost in a race).'],
            'managed_by_auth_portal' => ['status' => 409, 'message' => 'Accounts are managed by the Auth Portal.', 'meaning' => 'External auth mode: creating accounts or changing `is_active` / `is_agent` happens in the portal.'],
            'cannot_deactivate_self' => ['status' => 409, 'message' => 'You cannot deactivate your own account.', 'meaning' => 'An administrator deactivating themselves.'],
            'not_an_agent' => ['status' => 409, 'message' => 'This account does not take chats.', 'meaning' => 'Assigning categories to an account that is not an agent.'],
            'push_unavailable' => ['status' => 503, 'message' => 'Push notifications are not set up on this server.', 'meaning' => 'The VAPID keys are not configured.'],
            'no_push_devices' => ['status' => 409, 'message' => 'No browser is registered for notifications yet.', 'meaning' => 'Test push without a registered browser.'],
            'subscription_not_found' => ['status' => 404, 'message' => 'This device is not registered.', 'meaning' => 'The push subscription is not the caller\'s (or does not exist).'],
            'device_not_found' => ['status' => 404, 'message' => 'This device is not registered.', 'meaning' => 'The mobile device is not the caller\'s (or does not exist).'],

            // Auth tokens (mobile)
            'token_not_found' => ['status' => 404, 'message' => 'This token does not exist.', 'meaning' => 'The token id is not one of the caller\'s own tokens.'],
            'not_a_token_session' => ['status' => 409, 'message' => 'This call signs out a bearer token. Sign out of the dashboard with POST /logout instead.', 'meaning' => 'Logout was called with the dashboard\'s session cookie instead of a bearer token.'],

            // WhatsApp (admin only)
            'openwa_not_configured' => ['status' => 409, 'message' => 'Save the OpenWA address and API key in Settings > WhatsApp first.', 'meaning' => 'No gateway address or key saved.'],
            'openwa_unavailable' => ['status' => 503, 'message' => 'OpenWA could not be reached. Check that it is running and that the address in Settings > WhatsApp is right.', 'meaning' => 'The gateway is down or its address is refused by the outbound guard.'],
            'openwa_unauthorized' => ['status' => 502, 'message' => 'OpenWA did not accept the API key.', 'meaning' => 'The gateway refused our key (never mirrored as 401/403, which would end the dashboard session).'],
            'openwa_rejected' => ['status' => 502, 'message' => 'OpenWA could not complete the request.', 'meaning' => 'The gateway refused the call; `details.code` is its own code.'],
            'openwa_session_exists' => ['status' => 409, 'message' => 'OpenWA already has a session with that name.', 'meaning' => 'Create session: the name exists at the gateway.'],
            'session_name_taken' => ['status' => 409, 'message' => 'A session with this name already exists.', 'meaning' => 'Create session: the name is used by a live session here.'],
            'session_name_teardown_pending' => ['status' => 409, 'message' => 'OpenWA is still cleaning up a session with that name. Try again in a few seconds.', 'meaning' => 'The gateway is still tearing down a deleted session of that name.'],
            'session_not_startable' => ['status' => 409, 'message' => 'This session is already running.', 'meaning' => 'Only `created`, `disconnected` and `failed` sessions can start; `details.status` is the current one.', 'details' => ['status' => 'ready']],
            'session_not_stoppable' => ['status' => 409, 'message' => 'This session is not running.', 'meaning' => 'Stopping a session that is not running.'],
            'qr_not_available' => ['status' => 409, 'message' => 'No pairing code is available right now.', 'meaning' => 'The session is not waiting for a scan; `details.status` is the current one.', 'details' => ['status' => 'ready']],
            'webhook_rejected' => ['status' => 422, 'message' => 'OpenWA refused the webhook address.', 'meaning' => 'The gateway\'s SSRF guard refused our callback address (the message names the host to allow).'],
            'webhook_limit_reached' => ['status' => 409, 'message' => 'OpenWA has no room for another webhook on this session.', 'meaning' => 'The gateway\'s 16 webhooks per session are used up.'],
            'invalid_webhook' => ['status' => 400, 'message' => 'The request could not be processed.', 'meaning' => 'Webhook endpoint only: the signed body has no usable `event`.'],
            'payload_too_large' => ['status' => 413, 'message' => 'The request body is too large.', 'meaning' => 'Webhook endpoint only: more than 1 MiB.'],
            'queue_unavailable' => ['status' => 503, 'message' => 'The message could not be queued. Please try again.', 'meaning' => 'The queue refused a WhatsApp reply (it was stored and marked `failed`).'],
            'session_not_ready' => ['status' => 409, 'message' => 'The WhatsApp number is not connected right now.', 'meaning' => 'Reply on a chat whose session is not `ready`; `details.status` is the current one.', 'details' => ['status' => 'disconnected']],
            'reply_not_allowed' => ['status' => 409, 'message' => 'The customer has not written first.', 'meaning' => '`whatsapp.reply_only_to_inbound` is on and the customer never wrote.'],
            'daily_cap_reached' => ['status' => 429, 'message' => 'The daily sending limit of this number is used up.', 'meaning' => 'The session\'s daily send cap; `details.cap` and `details.retry_after` say how much and until when (00:00 UTC).', 'details' => ['cap' => 200, 'retry_after' => 3600], 'headers' => ['Retry-After' => '3600']],
        ];
    }

    /** Codes only the visitor (public) API raises. */
    private const PUBLIC_ONLY = ['widget_not_found', 'origin_not_allowed', 'channel_forbidden', 'realtime_unavailable', 'conversation_exists', 'conversation_not_ended', 'already_rated', 'rating_window_closed', 'whatsapp_unavailable'];

    /** Codes only the staff (management) API raises, besides every WhatsApp administration code. */
    private const MANAGEMENT_ONLY = [
        'csrf_mismatch', 'no_chat_access', 'auth_unavailable', 'auth_mode_unavailable', 'category_in_use', 'slug_taken', 'managed_by_auth_portal',
        'cannot_deactivate_self', 'not_an_agent', 'push_unavailable', 'no_push_devices', 'subscription_not_found', 'device_not_found', 'token_not_found',
        'not_a_token_session', 'already_claimed', 'at_capacity', 'conversation_not_open', 'conversation_not_live', 'invalid_webhook', 'payload_too_large',
        'queue_unavailable', 'reply_not_allowed', 'daily_cap_reached', 'qr_not_available', 'webhook_rejected', 'webhook_limit_reached',
    ];

    /**
     * The codes one reference lists in its introduction.
     *
     * @return array<string, ErrorSpec>
     */
    public static function forAudience(ApiAudience $audience): array
    {
        return array_filter(self::all(), static function (string $code) use ($audience): bool {
            $staffOnly = in_array($code, self::MANAGEMENT_ONLY, true) || str_starts_with($code, 'openwa_') || str_starts_with($code, 'session_not_') || str_starts_with($code, 'session_name_');
            $visitorOnly = in_array($code, self::PUBLIC_ONLY, true);

            return $audience === ApiAudience::Public ? ! $staffOnly : ! $visitorOnly;
        }, ARRAY_FILTER_USE_KEY);
    }

    /** @return ErrorSpec */
    public static function get(string $code): array
    {
        return self::all()[$code] ?? throw new InvalidArgumentException("Unknown API error code [{$code}]: add it to ErrorCatalogue.");
    }

    /**
     * The JSON body of an error example.
     *
     * @return array{error: array{code: string, message: string, details?: array<string, mixed>}}
     */
    public static function body(string $code): array
    {
        $spec = self::get($code);
        $error = ['code' => $code, 'message' => $spec['message']];

        if (isset($spec['details'])) {
            $error['details'] = $spec['details'];
        }

        return ['error' => $error];
    }
}
