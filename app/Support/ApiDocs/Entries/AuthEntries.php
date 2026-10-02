<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Auth\ApiTokenData;
use App\Data\Auth\StaffMeData;
use App\Data\Auth\StaffSignInData;
use App\Data\Auth\StaffTwoFactorChallengeData;
use App\Support\ApiDocs\Doc;

/** Who the credential belongs to and the caller's own tokens. */
final class AuthEntries implements EntryList
{
    public static function docs(): array
    {
        return [
            Doc::route('api.auth.token.store')
                ->in('Authentication')
                ->title('Sign in (password)')
                ->about("Trades an email and password for a **bearer token**, for a native staff app. It works in both auth modes: with local accounts the password is checked here; with an external auth portal the portal checks it (the portal's own token never reaches the client) and the roles come from the portal. Send the token as `Authorization: Bearer <token>` on every other call; it is shown once.\n\n**An account with a second factor** does not get a token from the password: the answer is `202` with a `challenge`, and the token comes from `POST /auth/token/two-factor`. Passkeys are not supported here (password and authenticator code or recovery code only). In the external auth mode the portal owns passwords and second factors; the portal this application talks to has no second-factor step, so there is no `202` there (an unexpected portal answer is `503 auth_unavailable`, never a token).\n\n**Refusals** are one answer, `401 invalid_credentials`, for an unknown email, a wrong password, a deactivated account and (local accounts) an account without a chat role: the call cannot be used to find out who has an account. With the external portal a person it signed in who has no chat role gets `403 no_chat_access`. A portal that cannot answer is `503 auth_unavailable` (never `401`: the credentials were not judged; retry after `Retry-After`).\n\nEach device gets its own token (`device_name`); a user keeps at most 10 devices (`staff_auth.max_tokens_per_user`), and a sign-in over the limit revokes the token used least recently. Sign out with `POST /auth/logout`.")
                ->created(StaffSignInData::class, 'Signed in. The `token` is shown once.')
                ->item(StaffTwoFactorChallengeData::class, 202, 'The password was right, but the account has a second factor: no token yet. Answer the challenge at `POST /auth/token/two-factor`.')
                ->errors([
                    'invalid_credentials',
                    'no_chat_access' => 'External auth mode only: the portal signed the person in but they have neither the administrator nor the agent role there.',
                    'auth_unavailable' => 'External auth mode only: the portal cannot be reached (or answered something unexpected). The credentials were not judged.',
                    'rate_limited' => 'Too many attempts for this email, this client address, or at all (the same budget as the dashboard login), or too many wrong passwords in a minute. Wait `Retry-After` seconds.',
                    'payload_too_large',
                ]),

            Doc::route('api.auth.token.two-factor')
                ->in('Authentication')
                ->title('Sign in (second factor)')
                ->about("Answers the `challenge` of `POST /auth/token` with the account's **authenticator code** (`code`) or one **recovery code** (`recovery_code`), and returns the token. It is the same check the dashboard does: a code that was already accepted is refused, and a recovery code is replaced by a new one when used.\n\nThe request names nobody: the account is the one the challenge was issued for, so a challenge cannot be used for someone else, and the device name is the one the password step was given. A challenge works **once** (a replay is `401 invalid_challenge`), lives 5 minutes and **burns after 5 wrong codes** (`details.attempts_remaining` counts down; at 0 the client signs in again from the password). Wrong codes are also counted per account across challenges, so a new challenge brings no fresh budget; a locked account answers `429` until the window passes, even for a right code.")
                ->created(StaffSignInData::class, 'Signed in. The `token` is shown once.')
                ->errors([
                    'invalid_challenge',
                    'invalid_two_factor_code',
                    'rate_limited' => 'Too many calls from this client address or with this challenge, or too many wrong codes for the account. Wait `Retry-After` seconds.',
                    'payload_too_large',
                ]),

            Doc::route('api.auth.me')
                ->in('Authentication')
                ->title('Show the signed-in user')
                ->about("The first call a client makes after signing in, and a cheap way to check that a stored token still works (`401 unauthenticated` / `session_revoked` otherwise).\n\nIt returns the same user object the dashboard receives, which auth driver is active (`fortify`: accounts of this installation, `pizzasys`: an external auth portal) and what that driver lets the user do, the bearer token the call was made with (`null` when the dashboard's session cookie was used), the public address and key of the realtime (websocket) server, and the server clock: compare `serverTime` with your own clock to correct clock skew before you count down any `expiresAt`.")
                ->item(StaffMeData::class),

            Doc::route('api.auth.tokens.index')
                ->in('Authentication')
                ->title('List my tokens')
                ->about("The caller's own bearer tokens, newest first: one per device that signed in (the name is the device name given at sign-in). `current` marks the token this call was made with. The token strings themselves are never returned again (only a hash is stored).\n\nTokens do not slide: each one stops working at `expiresAt` (issue time plus `SANCTUM_EXPIRATION_MINUTES`, 30 days by default), and deactivating the account or removing its last chat role deletes them all.")
                ->list(ApiTokenData::class),

            Doc::route('api.auth.tokens.destroy')
                ->in('Authentication')
                ->title('Revoke one of my tokens')
                ->about("Signs one of the caller's devices out. Only the caller's own tokens can be found: someone else's id is `404 token_not_found`, never `403`. With the external auth portal the portal session behind the token ends too, and the portal token is logged out upstream.\n\nTo sign out the device you are using, call `POST /auth/logout`.")
                ->noContent(204, 'Revoked.')
                ->errors(['token_not_found' => 'The id is not one of the caller\'s own tokens.']),

            Doc::route('api.auth.logout')
                ->in('Authentication')
                ->title('Sign out this device')
                ->about("Revokes the bearer token the call was made with, and only that one: the user's other devices keep theirs. A mobile app calls it on sign-out and then deletes its stored token and any realtime connection.\n\nCalled with the dashboard's session cookie instead of a bearer token it answers `409 not_a_token_session`: the dashboard signs out with `POST /logout`.")
                ->noContent(204, 'The token is revoked.')
                ->errors(['not_a_token_session']),
        ];
    }
}
