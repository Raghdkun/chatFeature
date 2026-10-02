/**
 * The client's URLs and verbs against the app's route table (read from the PHP route files, see `php-routes.ts`): every call the
 * WhatsApp, notification and staff clients make must be a route the server defines, with that verb. A renamed or removed route, or a
 * client that spells a path differently, fails here instead of as a 404 in production.
 *
 * Why not `php artisan route:list --json`: it boots the application (a database, the right PHP on the PATH) inside a unit test run; this
 * reads the same files the framework loads, so it needs nothing and takes milliseconds. The Playwright run exercises the real routes.
 */
import { describe, expect, it } from 'vite-plus/test';
import { staffRoutes } from '@/lib/chat-api/staff';
import { notificationRoutes } from '@/lib/notifications/routes';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import { parseRoutes, pathOf, routeTable } from '@/tests/php-routes';

const table = routeTable();

const publicAssets = import.meta.glob<string>(['/public/sw.js'], {
    eager: true,
    query: '?raw',
    import: 'default',
});

type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Call = [verb: Verb, path: string];

/**
 * Calls the client already makes that the backend fix of the P5/P6 audit adds (`fix/p56-backend`). Remove the entry when that branch is
 * merged: once the route exists this test FAILS on purpose (a list that tolerates both would never notice the route going missing).
 */
const PENDING_BACKEND_FIX = new Set<string>([
    'DELETE /api/v1/whatsapp/chats/{}',
]);

function expectRouted(calls: Call[]): void {
    const missing: string[] = [];
    const stale: string[] = [];

    for (const [verb, path] of calls) {
        const key = `${verb} ${path}`;
        const exists = table.has(key);

        if (PENDING_BACKEND_FIX.has(key)) {
            if (exists) {
                stale.push(key);
            }

            continue;
        }

        if (!exists) {
            missing.push(key);
        }
    }

    expect(
        missing,
        'client calls that no route answers (a typo, a rename, or a route that was removed)',
    ).toEqual([]);
    expect(
        stale,
        'PENDING_BACKEND_FIX entries whose route exists now: delete them from the list',
    ).toEqual([]);
}

describe('the parser reads the project’s route style', () => {
    it('applies the prefixes of nested groups, a prefix on an earlier line and the mount point', () => {
        const routes = parseRoutes(
            [
                "Route::middleware(['a'])->prefix('whatsapp')->group(function () {",
                "    Route::get('sessions', [X::class, 'index']);",
                "    Route::prefix('sessions/{session}')->whereUlid('session')->group(function () {",
                "        Route::get('/', [X::class, 'show']);",
                "        Route::post('start', [X::class, 'start'])->name('n');",
                '    });',
                '});',
                "Route::prefix('widgets/{key}')",
                "    ->where(['key' => 'x'])",
                '    ->group(function () {',
                "        Route::post('whatsapp-handoff', [Y::class, 'store']);",
                '    });',
                "Route::inertia('settings/notifications', 'settings/notifications')->name('n');",
                "Route::withoutMiddleware('web')->get('manifest.webmanifest', Z::class);",
                "// Route::get('commented', [X::class, 'no']);",
            ].join('\n'),
            '/api/v1',
        );

        expect(routes.map((r) => `${r.method} ${r.uri}`)).toEqual([
            'GET /api/v1/whatsapp/sessions',
            'GET /api/v1/whatsapp/sessions/{}',
            'POST /api/v1/whatsapp/sessions/{}/start',
            'POST /api/v1/widgets/{}/whatsapp-handoff',
            'GET /api/v1/settings/notifications',
            'GET /api/v1/manifest.webmanifest',
        ]);
    });

    it('finds the real route files (the table is not empty by accident)', () => {
        expect(table.size).toBeGreaterThan(100);
        expect(table.has('GET /api/v1/whatsapp/sessions')).toBe(true);
        expect(table.has('POST /api/v1/me/presence/heartbeat')).toBe(true);
        expect(table.has('GET /inbox')).toBe(true);
    });
});

describe('WhatsApp (admin only)', () => {
    const { api, pages } = waRoutes;

    it('every page and API call of the WhatsApp UI is a routed URL with that verb', () => {
        expectRouted([
            ['GET', pathOf(pages.inbox)],
            ['GET', pathOf(pages.chat, 1)],
            ['GET', pathOf(pages.settings)],

            ['GET', pathOf(api.settings)],
            ['PUT', pathOf(api.settings)],
            ['POST', pathOf(api.connectionTest)],
            ['GET', pathOf(api.sessions)],
            ['POST', pathOf(api.sessions)],
            ['PATCH', pathOf(api.session, 1)],
            ['DELETE', pathOf(api.session, 1)],
            ['POST', pathOf(api.sessionStart, 1)],
            ['POST', pathOf(api.sessionStop, 1)],
            ['POST', pathOf(api.sessionSync, 1)],
            ['POST', pathOf(api.sessionWebhook, 1)],
            ['GET', pathOf(api.sessionQr, 1)],
            ['GET', pathOf(api.chats)],
            ['GET', pathOf(api.chat, 1)],
            ['DELETE', pathOf(api.chat, 1)],
            ['GET', pathOf(api.chatMessages, 1)],
            ['POST', pathOf(api.chatMessages, 1)],
            ['POST', pathOf(api.chatRead, 1)],
            ['POST', pathOf(api.chatArchive, 1)],
            ['POST', pathOf(api.chatUnarchive, 1)],
            ['GET', pathOf(api.export)],
            ['GET', pathOf(api.widgetWhatsApp, 1)],
            ['PUT', pathOf(api.widgetWhatsApp, 1)],
        ]);
    });

    it('the visitor panel’s hand-off call (relative to the boot config’s api.base) is the public route', () => {
        expectRouted([
            [
                'POST',
                `/api/v1/public${pathOf(waRoutes.handoff, 1).replace(/^(?!\/)/, '/')}`,
            ],
        ]);
    });
});

describe('notifications', () => {
    const { api, pages } = notificationRoutes;

    it('every page and API call of the notification client is a routed URL with that verb', () => {
        expectRouted([
            ['GET', pages.settings],
            ['GET', pathOf(() => api.settings)],
            ['PUT', pathOf(() => api.settings)],
            ['GET', pathOf(() => api.subscriptions)],
            ['POST', pathOf(() => api.subscriptions)],
            ['DELETE', pathOf(api.subscription, 1)],
            ['POST', pathOf(() => api.test)],
            ['GET', notificationRoutes.manifest],
        ]);
    });

    it('serves the service worker as a static file of public/ at the path the client registers', () => {
        expect(notificationRoutes.worker).toBe('/sw.js');
        expect(Object.keys(publicAssets)).toEqual(['/public/sw.js']);
    });

    it('the test push is not shadowed by the subscription id route (`test` is not an id)', () => {
        // `DELETE .../push-subscriptions/{id}` only takes ULIDs (whereUlid), so a POST to `.../test` is its own route.
        expect(table.has('POST /api/v1/me/push-subscriptions/test')).toBe(true);
    });
});

describe('the staff inbox', () => {
    const { api, pages } = staffRoutes;

    it('every page and API call of the staff client is a routed URL with that verb', () => {
        expectRouted([
            ['GET', pathOf(pages.dashboard)],
            ['GET', pathOf(pages.inbox)],
            ['GET', pathOf(pages.conversation, 1)],
            ['GET', pathOf(pages.offlineTickets)],
            ['GET', pathOf(pages.history)],
            ['GET', pathOf(staffRoutes.session.keepAlive)],

            ['GET', pathOf(api.conversations)],
            ['GET', pathOf(api.queue)],
            ['GET', pathOf(api.conversation, 1)],
            ['GET', pathOf(api.messages, 1)],
            ['POST', pathOf(api.messages, 1)],
            ['POST', pathOf(api.claim, 1)],
            ['POST', pathOf(api.attachments, 1)],
            ['POST', pathOf(api.receipts, 1)],
            ['POST', pathOf(api.end, 1)],
            ['POST', pathOf(api.close, 1)],
            ['POST', pathOf(api.transfer, 1)],
            ['GET', pathOf(api.transferTargets, 1)],
            ['GET', pathOf(api.export)],
            ['GET', pathOf(api.presence)],
            ['PUT', pathOf(api.presence)],
            ['POST', pathOf(api.heartbeat)],
        ]);
    });
});
