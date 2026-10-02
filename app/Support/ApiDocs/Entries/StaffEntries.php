<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Chat\PresenceData;
use App\Data\Notifications\DeviceTokenData;
use App\Data\Notifications\NotificationSettingsData;
use App\Data\Notifications\PushSubscriptionData;
use App\Data\Notifications\PushTestResultData;
use App\Support\ApiDocs\Doc;

/** The caller's own presence, notification preferences, web push subscriptions and mobile devices. */
final class StaffEntries implements EntryList
{
    public static function docs(): array
    {
        return [
            Doc::route('api.me.presence.show')
                ->in('Presence')
                ->title('Show my presence')
                ->about('The caller\'s EFFECTIVE status: silence (no heartbeat for 90 seconds) and auto-away are already applied, exactly as routing, the public availability and the roster read it.')
                ->item(PresenceData::class),

            Doc::route('api.me.presence.update')
                ->in('Presence')
                ->title('Choose my status')
                ->about("Sets `online`, `away` or `offline`; it counts as a heartbeat for `online` and `away`. A status is **pinned** (`isManual: true`) unless `automatic: true` accompanies `online`: then the app keeps the agent `online` while it is visible and the server moves them to `away` after `presence.auto_away_minutes` (5) of hidden heartbeats. The dashboard sends `online` with `automatic: true`.\n\nThis is the only call that turns an `offline` agent back on: a heartbeat never does.")
                ->item(PresenceData::class),

            Doc::route('api.me.presence.heartbeat')
                ->in('Presence')
                ->title('Send a heartbeat')
                ->about("Call it every 30 seconds while the app is open, with `visible` saying whether it is in the foreground (a backgrounded mobile app sends `false`; absent counts as `true`). It refreshes an `online` or `away` agent and never turns an `offline` one on, nor revives an agent whose record expired (3 minutes after the last sign of life).\n\nThe answer is the EFFECTIVE status, so a client whose record the server lost learns at once that it is `offline` and shows its \"Go online\" prompt. An agent who chose `offline` keeps sending heartbeats while looking at the app: their status does not change.")
                ->item(PresenceData::class),

            Doc::route('api.me.notification-settings.show')
                ->in('Notifications', 'Settings')
                ->title('Show my notification settings')
                ->about('A member who never saved anything gets the defaults (everything on, quiet hours off at `22:00` to `07:00` in their own timezone, `promptState: never`) and no row is created.')
                ->item(NotificationSettingsData::class),

            Doc::route('api.me.notification-settings.update')
                ->in('Notifications', 'Settings')
                ->title('Change my notification settings')
                ->about('Any subset of the fields. `quiet_hours` is merged field by field into what is saved, and the rule that start and end differ is applied to the merged result.')
                ->item(NotificationSettingsData::class)
                ->errors(['validation_failed' => 'A field is invalid, or the merged quiet hours start and end at the same time (reported on the field the request changed).']),

            Doc::route('api.me.push-subscriptions.index')
                ->in('Notifications', 'Web push')
                ->title('List my push subscriptions')
                ->about('The caller\'s browsers that receive web push, newest first. The endpoint and the keys are never returned.')
                ->list(PushSubscriptionData::class),

            Doc::route('api.me.push-subscriptions.store')
                ->in('Notifications', 'Web push')
                ->title('Register a browser for push')
                ->about("Takes the browser's `PushSubscription.toJSON()`. An **upsert by the hash of the endpoint**: `201` for a new browser, `200` when it was known (keys refreshed). A browser another member of staff signed in to is handed over to the caller. At most `push.max_subscriptions_per_user` (10) are kept; the least recently used go first.\n\nThe endpoint must be an https URL of a **public** host on port 443 (loopback, private and metadata addresses are refused whatever `PORTAL_ALLOW_PRIVATE_HOSTS` says, because the server posts to it).")
                ->created(PushSubscriptionData::class, 'A new browser.')
                ->item(PushSubscriptionData::class, 200, 'A browser the server already knew.')
                ->errors(['push_unavailable' => 'The VAPID keys are not configured.']),

            Doc::route('api.me.push-subscriptions.test')
                ->in('Notifications', 'Web push')
                ->title('Send a test push')
                ->about('A REAL push to the caller\'s own browsers (5 seconds per device, at most 5 devices, 10 seconds in total, most recently used first). Devices the deadline did not reach count as `failed`; subscriptions the push service says are gone are deleted and counted as `removed`.')
                ->item(PushTestResultData::class)
                ->errors(['no_push_devices', 'push_unavailable']),

            Doc::route('api.me.push-subscriptions.destroy')
                ->in('Notifications', 'Web push')
                ->title('Remove a push subscription')
                ->about('Only the caller\'s own: another member\'s subscription id (or an unknown one) is `404 subscription_not_found`, never `403`.')
                ->noContent(204, 'Removed.')
                ->errors(['subscription_not_found']),

            Doc::route('api.me.devices.store')
                ->in('Notifications', 'Mobile devices')
                ->title('Register a mobile device')
                ->about("Stores the device's FCM registration token **encrypted** (an upsert by the token's hash; a token another member registered moves to the caller) and answers `{ id, platform, lastSeenAt }`: the token is never returned.\n\n**This is a stub.** Nothing is sent to registered devices yet: the `FcmChannel` is not implemented and `push.fcm.enabled` is off. Registering now lets an app ship before the channel does; see the mobile readiness notes for what a real FCM channel still needs.")
                ->created(DeviceTokenData::class, 'A new registration.')
                ->item(DeviceTokenData::class, 200, 'A token that was already registered.'),

            Doc::route('api.me.devices.destroy')
                ->in('Notifications', 'Mobile devices')
                ->title('Remove a mobile device')
                ->about('Only the caller\'s own registration; another member\'s id (or an unknown one) is `404 device_not_found`.')
                ->noContent(204, 'Removed.')
                ->errors(['device_not_found']),
        ];
    }
}
