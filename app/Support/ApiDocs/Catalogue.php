<?php

namespace App\Support\ApiDocs;

use App\Support\ApiDocs\Entries\AuthEntries;
use App\Support\ApiDocs\Entries\ConversationEntries;
use App\Support\ApiDocs\Entries\DirectoryEntries;
use App\Support\ApiDocs\Entries\PublicEntries;
use App\Support\ApiDocs\Entries\StaffEntries;
use App\Support\ApiDocs\Entries\WhatsAppEntries;
use App\Support\ApiDocs\Entries\WidgetEntries;
use Illuminate\Routing\Route;
use LogicException;

/**
 * The register of endpoint entries ({@see Doc}) by route name, and the descriptions of the groups they are filed under.
 * `ApiDocsGuardTest` fails when a route under `api/v1` or `webhooks` has no entry (or an entry has no route), unless the route is on
 * its explicit allow-list of intentionally undocumented routes.
 */
final class Catalogue
{
    /**
     * Routes that are deliberately left out of the reference, by route name (or `METHOD /path` for an unnamed route) with the reason.
     * Empty today: every route is documented. Add an entry here, with a reason, only for a route that must not appear.
     *
     * @return array<string, string>
     */
    public static function undocumented(): array
    {
        return [];
    }

    /** @var array<string, Doc>|null */
    private static ?array $docs = null;

    /**
     * @return array<string, Doc> route name => entry
     */
    public static function all(): array
    {
        if (self::$docs !== null) {
            return self::$docs;
        }

        $docs = [];

        foreach (self::sources() as $source) {
            foreach ($source::docs() as $doc) {
                if (isset($docs[$doc->route])) {
                    throw new LogicException("Two API reference entries for route [{$doc->route}].");
                }

                $docs[$doc->route] = $doc;
            }
        }

        return self::$docs = $docs;
    }

    public static function for(Route $route): ?Doc
    {
        $name = $route->getName();

        return $name === null ? null : (self::all()[$name] ?? null);
    }

    /**
     * @return list<class-string<Entries\EntryList>>
     */
    private static function sources(): array
    {
        return [
            AuthEntries::class,
            StaffEntries::class,
            ConversationEntries::class,
            DirectoryEntries::class,
            WidgetEntries::class,
            WhatsAppEntries::class,
            PublicEntries::class,
        ];
    }

    /**
     * Group names in reading order, per audience.
     *
     * @return list<string>
     */
    public static function groupOrder(ApiAudience $audience): array
    {
        return match ($audience) {
            ApiAudience::Management => ['Authentication', 'Presence', 'Notifications', 'Conversations', 'Messages & attachments', 'Categories', 'Agents', 'Widgets', 'WhatsApp (admin only)'],
            ApiAudience::Public => ['Widget config', 'Sessions', 'Conversation', 'Messages & attachments', 'Rating', 'Offline tickets', 'WhatsApp hand-off', 'Realtime', 'Widget delivery'],
        };
    }

    public static function groupDescription(string $group): string
    {
        return match ($group) {
            'Authentication' => 'Signing in from a native client (a password, plus a second factor for accounts that have one, answered with a bearer token), who the credential belongs to, and the caller\'s own bearer tokens (one per signed-in device). The two sign-in calls are the only management endpoints that need no credential.',
            'Presence' => 'The caller\'s own availability. Routing, the public `availability` call and the roster all read the same effective status.',
            'Notifications' => 'The caller\'s own notification preferences, web push subscriptions and mobile devices.',
            'Conversations' => 'The staff inbox: lists, the queue, the atomic accept, and ending, closing and transferring a chat. Agents see only what `Conversation::visibleTo` allows; administrators see everything.',
            'Messages & attachments' => 'Reading and writing the messages of a conversation, image uploads, read receipts and typing.',
            'Categories' => 'The topics visitors pick. Reading is open to every staff member; writes are administrators only.',
            'Agents' => 'The staff directory and the categories each agent serves (administrators only).',
            'Widgets' => 'The embeddable chat widgets: operational settings, the draft/publish config workflow, allowed domains, greetings and embed codes (administrators only).',
            'WhatsApp (admin only)' => '**Administrators only.** WhatsApp is recorded for the admin inbox and never shown to agents: they get `403`, and nothing in the answer says WhatsApp exists. Documented here for completeness; most integrations never need it.',
            'Widget config' => 'What a visitor client needs before it starts: the published configuration and the live availability. Cacheable, origin-checked.',
            'Sessions' => 'A visitor session is the `vt_...` bearer token every other call carries.',
            'Conversation' => 'Starting, reading, ending and cancelling the visitor\'s chat. A visitor never lists history: at most one open live chat.',
            'Rating' => 'The visitor\'s answer to the rating prompt after a chat ended.',
            'Offline tickets' => 'The offline form: a separate ticket when nobody is available.',
            'WhatsApp hand-off' => 'Continue the conversation in WhatsApp: a code and a `wa.me` link.',
            'Realtime' => 'Authorisation of the visitor\'s websocket channel (Pusher protocol, served by Laravel Reverb).',
            'Widget delivery' => 'Not JSON APIs: the script, iframe page and hosted page a custom front end can embed or build on.',
            default => '',
        };
    }

    public static function subgroupDescription(string $group, string $subgroup): string
    {
        return match ($group.'/'.$subgroup) {
            'Notifications/Settings' => 'Preferences and the first-login dialog state.',
            'Notifications/Web push' => 'Browsers that receive web push. Registered by the dashboard; a native app uses devices.',
            'Notifications/Mobile devices' => 'Registrations for a future native app. A stub: tokens are stored encrypted but nothing is sent to them yet (`push.fcm.enabled` is off).',
            'Widgets/Settings' => 'Widget CRUD and operational settings.',
            'Widgets/Config' => 'The draft/publish workflow of the widget configuration.',
            'Widgets/Embedding' => 'Domains, categories, greetings and embed codes.',
            'WhatsApp (admin only)/Sessions' => 'The WhatsApp numbers (one OpenWA session each).',
            'WhatsApp (admin only)/Settings' => 'The gateway address and key and the sending rules.',
            'WhatsApp (admin only)/Inbox' => 'Recorded chats and messages.',
            'WhatsApp (admin only)/Widget link' => 'Which session a widget hands visitors over to.',
            'WhatsApp (admin only)/Webhook' => 'The inbound endpoint OpenWA calls.',
            default => '',
        };
    }
}
