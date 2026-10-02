<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Visitors\VisitorTokenService;
use App\Domain\WhatsApp\Actions\CreateWhatsAppSession;
use App\Domain\WhatsApp\Actions\DeleteWaChat;
use App\Domain\WhatsApp\Actions\DeleteWhatsAppSession;
use App\Domain\WhatsApp\Actions\FetchSessionQr;
use App\Domain\WhatsApp\Actions\LinkWidgetSession;
use App\Domain\WhatsApp\Actions\MarkChatRead;
use App\Domain\WhatsApp\Actions\ReregisterWebhook;
use App\Domain\WhatsApp\Actions\SendReply;
use App\Domain\WhatsApp\Actions\SetChatArchived;
use App\Domain\WhatsApp\Actions\StartWhatsAppSession;
use App\Domain\WhatsApp\Actions\StopWhatsAppSession;
use App\Domain\WhatsApp\Actions\SyncWhatsAppSession;
use App\Domain\WhatsApp\Actions\TestOpenWaConnection;
use App\Domain\WhatsApp\Actions\UpdateSessionPacing;
use App\Domain\WhatsApp\Actions\UpdateWhatsAppSettings;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Models\AuditLog;
use App\Models\Setting;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Closure;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The isolation matrix (decision P6-D1, the P6 exit criterion): every WhatsApp route, page and action is administrators-only. An active
 * administrator (with or without the agent role) passes; an agent, an account without a chat role, a deactivated administrator, a visitor
 * token and a guest are all refused, and a refused call changes nothing, calls nothing and queues nothing. No WhatsApp data reaches anything an
 * agent can see (conversation lists and search, the staff export, Inertia props, realtime), and no secret reaches any response or log.
 */
class WhatsAppIsolationTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, RefreshDatabase, WhatsAppFixtures;

    private const API_KEY = 'owa_k1_isolation-test-api-key-0123456789';

    private const WEBHOOK_SECRET = 'isolation-webhook-secret-of-forty-characters-01';

    private WhatsAppSession $session;

    private WaChat $chat;

    private WaMessage $message;

    private Widget $widget;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        Storage::fake('local');
        $this->app->instance(WaMediaUrls::class, $this->app->make(SignedWaMediaUrls::class));
        settings()->set('whatsapp.openwa.api_key', self::API_KEY);

        $this->session = WhatsAppSession::factory()->qr()->withWebhook(self::WEBHOOK_SECRET)->create(['name' => 'support-main', 'phone_e164' => '+4915123456789']);
        $this->chat = WaChat::factory()->for($this->session, 'session')->create(['push_name' => 'Anna Customer', 'inbound_initiated' => true]);
        $this->message = WaMessage::factory()->for($this->chat, 'chat')->inbound()->create(['body' => 'Where is my refund for invoice 4711?']);
        Storage::disk('local')->put('whatsapp/media/2026/10/iso.jpg', 'x');
        $this->widget = Widget::factory()->create();
    }

    /**
     * Every admin-only route: `[method, uri template, body]`. `{s}` session ulid, `{c}` chat ulid, `{w}` widget ulid, `{m}` a signed media URL.
     *
     * @return iterable<string, array{string, string, array<string, mixed>}>
     */
    public static function adminRoutes(): iterable
    {
        yield 'sessions list' => ['GET', '/api/v1/whatsapp/sessions', []];
        yield 'session create' => ['POST', '/api/v1/whatsapp/sessions', ['name' => 'intruder']];
        yield 'session show' => ['GET', '/api/v1/whatsapp/sessions/{s}', []];
        yield 'session pacing' => ['PATCH', '/api/v1/whatsapp/sessions/{s}', ['daily_send_cap' => 1]];
        yield 'session delete' => ['DELETE', '/api/v1/whatsapp/sessions/{s}', []];
        yield 'session start' => ['POST', '/api/v1/whatsapp/sessions/{s}/start', []];
        yield 'session stop' => ['POST', '/api/v1/whatsapp/sessions/{s}/stop', []];
        yield 'session sync' => ['POST', '/api/v1/whatsapp/sessions/{s}/sync', []];
        yield 'session webhook' => ['POST', '/api/v1/whatsapp/sessions/{s}/webhook', []];
        yield 'session qr' => ['GET', '/api/v1/whatsapp/sessions/{s}/qr', []];
        yield 'settings show' => ['GET', '/api/v1/whatsapp/settings', []];
        yield 'settings update' => ['PUT', '/api/v1/whatsapp/settings', ['enabled' => true, 'api_key' => 'owa_k1_intruder-key']];
        yield 'settings test' => ['POST', '/api/v1/whatsapp/settings/test', []];
        yield 'chats list' => ['GET', '/api/v1/whatsapp/chats', []];
        yield 'chats search' => ['GET', '/api/v1/whatsapp/chats?q=refund', []];
        yield 'chat show' => ['GET', '/api/v1/whatsapp/chats/{c}', []];
        yield 'chat messages' => ['GET', '/api/v1/whatsapp/chats/{c}/messages', []];
        yield 'chat reply' => ['POST', '/api/v1/whatsapp/chats/{c}/messages', ['body' => 'Hello from an intruder']];
        yield 'chat read' => ['POST', '/api/v1/whatsapp/chats/{c}/read', []];
        yield 'chat archive' => ['POST', '/api/v1/whatsapp/chats/{c}/archive', []];
        yield 'chat unarchive' => ['POST', '/api/v1/whatsapp/chats/{c}/unarchive', []];
        yield 'chat delete' => ['DELETE', '/api/v1/whatsapp/chats/{c}', []];
        yield 'export' => ['GET', '/api/v1/whatsapp/export', []];
        yield 'export chats' => ['GET', '/api/v1/whatsapp/export?resource=chats&format=json', []];
        yield 'media' => ['GET', '{m}', []];
        yield 'widget link show' => ['GET', '/api/v1/widgets/{w}/whatsapp', []];
        yield 'widget link update' => ['PUT', '/api/v1/widgets/{w}/whatsapp', ['session' => null]];
        // P7: the WhatsApp numbers of the analytics API are WhatsApp data too: same rule, same middleware.
        yield 'analytics whatsapp' => ['GET', '/api/v1/analytics/whatsapp', []];
        yield 'page inbox' => ['GET', '/whatsapp', []];
        yield 'page chat' => ['GET', '/whatsapp/chats/{c}', []];
        yield 'page settings' => ['GET', '/settings/whatsapp', []];
    }

    private function resolve(string $uri): string
    {
        if ($uri === '{m}') {
            return app(WaMediaUrls::class)->url($this->imageMessage());
        }

        return str_replace(['{s}', '{c}', '{w}'], [$this->session->ulid, $this->chat->ulid, $this->widget->ulid], $uri);
    }

    private function imageMessage(): WaMessage
    {
        return WaMessage::query()->where('media_path', 'whatsapp/media/2026/10/iso.jpg')->first()
            ?? WaMessage::factory()->for($this->chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/iso.jpg']);
    }

    /**
     * @return array<string, int>
     */
    private function snapshot(): array
    {
        return [
            'sessions' => WhatsAppSession::withTrashed()->count(),
            'chats' => WaChat::query()->count(),
            'messages' => WaMessage::query()->count(),
            'audit' => AuditLog::query()->count(),
            'settings' => Setting::query()->count(),
            'key' => crc32(settings()->string('whatsapp.openwa.api_key')),
            'enabled' => (int) settings()->bool('whatsapp.enabled'),
            'unread' => (int) WaChat::query()->sum('unread_by_admin'),
            'status' => crc32((string) $this->chat->fresh()?->status->value.$this->session->fresh()?->status->value),
            'linked' => (int) Widget::query()->whereNotNull('whatsapp_session_id')->count(),
        ];
    }

    private function call_(string $method, string $uri, array $body, ?User $as = null, ?string $visitorToken = null): TestResponse
    {
        $request = $as === null ? $this : $this->actingAs($as, 'sanctum');

        if ($visitorToken !== null) {
            $request = $request->withToken($visitorToken);
        }

        return $request->json($method, $this->resolve($uri), $body);
    }

    // ---- who passes --------------------------------------------------------------------------------------------------------

    #[DataProvider('adminRoutes')]
    public function test_an_active_administrator_gets_through_with_or_without_the_agent_role(string $method, string $uri, array $body): void
    {
        $people = $this->whatsAppPeople();
        Queue::fake();

        foreach (['admin', 'adminAndAgent'] as $who) {
            $response = $this->call_($method, $uri, $body, $people[$who]);

            $this->assertNotContains($response->getStatusCode(), [401, 403], "{$who} refused on {$method} {$uri}: ".$response->getContent());
        }
    }

    // ---- who does not ------------------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{string, string, array<string, mixed>, string}>
     */
    public static function refusals(): iterable
    {
        foreach (self::adminRoutes() as $name => [$method, $uri, $body]) {
            foreach (['agent', 'noRole', 'inactiveAdmin', 'inactiveAgent', 'visitor', 'guest'] as $who) {
                yield "{$name}: {$who}" => [$method, $uri, $body, $who];
            }
        }
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('refusals')]
    public function test_everybody_else_is_refused_and_nothing_happens(string $method, string $uri, array $body, string $who): void
    {
        Queue::fake();
        $this->recordBroadcasts();
        $people = $this->whatsAppPeople();
        $visitor = Visitor::factory()->create(['widget_id' => $this->widget->id]);
        $token = app(VisitorTokenService::class)->issue($visitor)->plaintext;
        $this->resolve($uri);
        $before = $this->snapshot();

        $response = match ($who) {
            'visitor' => $this->call_($method, $uri, $body, visitorToken: $token),
            'guest' => $this->call_($method, $uri, $body),
            default => $this->call_($method, $uri, $body, $people[$who]),
        };

        $status = $response->getStatusCode();
        $expected = match ($who) {
            'agent' => [403],
            'noRole' => [403],
            'inactiveAdmin', 'inactiveAgent' => [401, 403],
            'visitor', 'guest' => [401],
        };
        $this->assertContains($status, $expected, "{$who} got {$status} on {$method} {$uri}: ".$response->getContent());
        $this->assertSame($before, $this->snapshot(), 'a refused call changes nothing');
        $this->openWa()->assertNothingCalled();
        Queue::assertNothingPushed();

        $content = $response->getContent();
        foreach (['Anna Customer', 'refund', 'support-main', '4915123456789', 'iVBOR'] as $leak) {
            $this->assertStringNotContainsString($leak, (string) $content, "{$who} was shown WhatsApp data on {$method} {$uri}");
        }
    }

    public function test_no_whatsapp_route_is_missing_from_the_matrix(): void
    {
        $known = [];

        foreach (self::adminRoutes() as [$method, $uri]) {
            $path = $uri === '{m}' ? '/api/v1/whatsapp/media/{m}' : preg_replace(['#\{s\}#', '#\{c\}#', '#\{w\}#'], '{x}', $uri);
            $known[$method.' '.trim((string) parse_url((string) $path, PHP_URL_PATH), '/')] = true;
        }

        $registered = [];

        foreach (Route::getRoutes() as $route) {
            $uri = $route->uri();

            if (! str_contains($uri, 'whatsapp') || str_starts_with($uri, 'api/v1/public/')) {
                continue;
            }

            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $registered[$method.' '.preg_replace('#\{[a-z]+\}#', '{x}', $uri)] = $route->middleware();
            }
        }

        $knownNormalised = [];
        foreach (array_keys($known) as $key) {
            $knownNormalised[preg_replace('#\{[a-z]+\}#', '{x}', $key)] = true;
        }

        $this->assertNotEmpty($registered);

        foreach ($registered as $route => $middleware) {
            $this->assertArrayHasKey($route, $knownNormalised, "the route [{$route}] is not in the isolation matrix");
            $this->assertContains('wa.admin', $middleware, "the route [{$route}] does not use wa.admin");
        }
    }

    public function test_the_two_routes_that_are_not_admin_routes_have_credentials_of_their_own(): void
    {
        $people = $this->whatsAppPeople();

        // The webhook: a signed-in administrator's session is no credential, only the signature is.
        $this->actingAs($people['admin'], 'sanctum')->postJson('/webhooks/openwa/'.$this->session->ulid, ['event' => 'message.received'])->assertUnauthorized();

        // The hand-off: only a visitor's token; a staff member's is not one.
        [$open] = $this->chatWidget();
        $this->actingAs($people['admin'], 'sanctum')->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])
            ->postJson('/api/v1/public/widgets/'.$open->public_key.'/whatsapp-handoff')->assertUnauthorized();
    }

    // ---- the actions answer for themselves too -----------------------------------------------------------------------------

    /**
     * @return iterable<string, array{Closure(self, User): mixed}>
     */
    public static function actionCalls(): iterable
    {
        yield 'create a session' => [fn (self $t, User $u) => app(CreateWhatsAppSession::class)->handle('intruder', $u)];
        yield 'start' => [fn (self $t, User $u) => app(StartWhatsAppSession::class)->handle($t->session, $u)];
        yield 'stop' => [fn (self $t, User $u) => app(StopWhatsAppSession::class)->handle($t->session, $u)];
        yield 'sync' => [fn (self $t, User $u) => app(SyncWhatsAppSession::class)->handle($t->session, $u)];
        yield 'webhook' => [fn (self $t, User $u) => app(ReregisterWebhook::class)->handle($t->session, $u)];
        yield 'delete' => [fn (self $t, User $u) => app(DeleteWhatsAppSession::class)->handle($t->session, $u)];
        yield 'qr' => [fn (self $t, User $u) => app(FetchSessionQr::class)->handle($t->session, $u)];
        yield 'pacing' => [fn (self $t, User $u) => app(UpdateSessionPacing::class)->handle($t->session, ['daily_send_cap' => 1], $u)];
        yield 'settings' => [fn (self $t, User $u) => app(UpdateWhatsAppSettings::class)->handle(['enabled' => true], $u)];
        yield 'connection test' => [fn (self $t, User $u) => app(TestOpenWaConnection::class)->handle($u)];
        yield 'reply' => [fn (self $t, User $u) => app(SendReply::class)->handle($t->chat, $u, 'hello')];
        yield 'read' => [fn (self $t, User $u) => app(MarkChatRead::class)->handle($t->chat, $u)];
        yield 'archive' => [fn (self $t, User $u) => app(SetChatArchived::class)->handle($t->chat, true, $u)];
        yield 'delete a chat' => [fn (self $t, User $u) => app(DeleteWaChat::class)->handle($t->chat->ulid, $u)];
        yield 'link a widget' => [fn (self $t, User $u) => app(LinkWidgetSession::class)->handle($t->widget, null, $u)];
    }

    /**
     * @param  Closure(self, User): mixed  $call
     */
    #[DataProvider('actionCalls')]
    public function test_every_action_refuses_an_agent_by_itself_without_the_route_in_front(Closure $call): void
    {
        $agent = $this->whatsAppPeople()['agent'];
        $before = $this->snapshot();

        try {
            $call($this, $agent);
            $this->fail('an agent was allowed to run the action');
        } catch (AuthorizationException) {
            $this->assertSame($before, $this->snapshot());
            $this->openWa()->assertNothingCalled();
        }
    }

    public function test_the_policy_says_no_on_its_own_to_everybody_but_an_active_administrator(): void
    {
        $people = $this->whatsAppPeople();

        foreach (['agent', 'noRole', 'inactiveAdmin', 'inactiveAgent'] as $who) {
            foreach (['viewAny', 'view', 'reply', 'archive', 'delete', 'export'] as $ability) {
                $this->assertTrue(Gate::forUser($people[$who])->denies($ability, $this->chat), "{$who} may {$ability}");
            }

            foreach (['manageSessions', 'manageSettings', 'view'] as $ability) {
                $this->assertTrue(Gate::forUser($people[$who])->denies($ability, $this->session), "{$who} may {$ability} a session");
            }

            $this->assertTrue(Gate::forUser($people[$who])->denies('view', $this->message));
        }

        foreach (['admin', 'adminAndAgent'] as $who) {
            $this->assertTrue(Gate::forUser($people[$who])->allows('reply', $this->chat));
        }
    }

    public function test_an_administrator_passes_every_ability_but_state_still_decides(): void
    {
        // `Gate::before` lets an administrator pass every ability, so the rules that depend on state are in the actions, not in the policy.
        $admin = $this->whatsAppPeople()['admin'];
        $this->session->forceFill(['status' => 'disconnected'])->save();

        $this->assertTrue(Gate::forUser($admin)->allows('reply', $this->chat));
        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/whatsapp/chats/'.$this->chat->ulid.'/messages', ['body' => 'hi'])->assertStatus(409)->assertJsonPath('error.code', 'session_not_ready');
    }

    // ---- no WhatsApp data anywhere an agent can look ----------------------------------------------------------------------

    public function test_whatsapp_chats_are_in_no_conversation_list_search_export_or_page_an_agent_or_the_history_can_see(): void
    {
        [$widget, $category] = $this->chatWidget();
        $agent = $this->availableAgent($category);
        $token = $this->visitorSession($widget, ['name' => 'Walter Webchat']);
        $this->queuedChat($token, $category, [$agent]);
        $people = $this->whatsAppPeople();

        foreach (['refund', '4711', 'Anna', 'Customer', '4915123456789', 'support-main'] as $needle) {
            $agentView = $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations?q='.urlencode($needle))->assertOk();
            $this->assertSame([], $agentView->json('data'), "the agent's search for [{$needle}] found something");

            $adminView = $this->actingAs($people['admin'], 'sanctum')->getJson('/api/v1/conversations?q='.urlencode($needle))->assertOk();
            $this->assertSame([], $adminView->json('data'), "even the administrator's conversation search finds no WhatsApp chat [{$needle}]");
        }

        $export = $this->actingAs($people['admin'], 'sanctum')->get('/api/v1/conversations/export?format=json')->assertOk()->streamedContent();
        $this->assertStringNotContainsString('Anna', $export);
        $this->assertStringNotContainsString('4711', $export);

        foreach (['/inbox', '/offline-tickets', '/dashboard'] as $page) {
            $html = $this->actingAs($agent)->get($page)->assertOk()->getContent();
            $this->assertStringNotContainsString('Anna Customer', $html, $page);
            $this->assertStringNotContainsString('refund', $html, $page);
            $this->assertStringNotContainsString('support-main', $html, $page);
        }

        $history = $this->actingAs($people['admin'])->get('/history')->assertOk()->getContent();
        $this->assertStringNotContainsString('Anna Customer', $history);
    }

    public function test_the_realtime_channel_is_closed_to_agents_and_visitors(): void
    {
        $this->useReverbBroadcaster();
        $people = $this->whatsAppPeople();
        $visitor = Visitor::factory()->create(['widget_id' => $this->widget->id]);
        $token = app(VisitorTokenService::class)->issue($visitor)->plaintext;
        $auth = ['socket_id' => '1234.5678', 'channel_name' => 'private-whatsapp-admin'];

        $this->actingAs($people['admin'], 'sanctum')->postJson('/broadcasting/auth', $auth)->assertOk();
        $this->actingAs($people['agent'], 'sanctum')->postJson('/broadcasting/auth', $auth)->assertForbidden();
        $this->withToken($token)->postJson('/api/v1/public/broadcasting/auth', $auth)->assertForbidden();
    }

    // ---- secrets -----------------------------------------------------------------------------------------------------------

    public function test_no_response_log_or_exception_ever_carries_the_api_key_the_webhook_secret_or_the_qr(): void
    {
        Log::spy();
        $admin = $this->whatsAppPeople()['admin'];
        $bodies = [];

        foreach ([
            '/api/v1/whatsapp/sessions', '/api/v1/whatsapp/sessions/'.$this->session->ulid, '/api/v1/whatsapp/settings', '/api/v1/whatsapp/chats',
            '/api/v1/whatsapp/chats/'.$this->chat->ulid, '/api/v1/whatsapp/chats/'.$this->chat->ulid.'/messages', '/api/v1/widgets/'.$this->widget->ulid.'/whatsapp',
            '/whatsapp', '/settings/whatsapp', '/whatsapp/chats/'.$this->chat->ulid,
        ] as $uri) {
            $bodies[$uri] = $this->actingAs($admin, 'sanctum')->getJson($uri)->getContent();
        }

        $bodies['test'] = $this->actingAs($admin, 'sanctum')->postJson('/api/v1/whatsapp/settings/test')->getContent();
        $bodies['update'] = $this->actingAs($admin, 'sanctum')->putJson('/api/v1/whatsapp/settings', ['daily_send_cap' => 0, 'api_key' => self::API_KEY])->getContent();
        $bodies['export'] = $this->actingAs($admin, 'sanctum')->get('/api/v1/whatsapp/export?resource=chats')->streamedContent();

        foreach ($bodies as $uri => $body) {
            $this->assertStringNotContainsString(self::API_KEY, (string) $body, $uri);
            $this->assertStringNotContainsString(self::WEBHOOK_SECRET, (string) $body, $uri);
            $this->assertStringNotContainsString('webhook_secret', (string) $body, $uri);
            $this->assertStringNotContainsString('last_qr', (string) $body, $uri);
        }

        // The page that shows the session is the only place a QR belongs, and it is fetched, never in a list or a prop.
        foreach (['/api/v1/whatsapp/sessions', '/whatsapp', '/settings/whatsapp'] as $uri) {
            $this->assertStringNotContainsString('iVBOR', $bodies[$uri], $uri);
        }

        Log::shouldNotHaveReceived('debug');
        Log::shouldNotHaveReceived('info', fn (string $message, array $context = []): bool => str_contains($message.json_encode($context), self::API_KEY));
    }

    public function test_the_stored_secrets_are_not_readable_in_the_database(): void
    {
        $rows = (string) json_encode([DB::table('settings')->get()->all(), DB::table('whatsapp_sessions')->get()->all()]);

        $this->assertStringNotContainsString(self::API_KEY, $rows);
        $this->assertStringNotContainsString(self::WEBHOOK_SECRET, $rows);
        $this->assertStringNotContainsString('iVBORw0KGgo', $rows, 'the QR image is encrypted at rest');
    }
}
