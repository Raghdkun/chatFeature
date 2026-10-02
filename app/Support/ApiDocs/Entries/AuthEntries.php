<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Auth\ApiTokenData;
use App\Data\Auth\StaffMeData;
use App\Support\ApiDocs\Doc;

/** Who the credential belongs to and the caller's own tokens. */
final class AuthEntries implements EntryList
{
    public static function docs(): array
    {
        return [
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
