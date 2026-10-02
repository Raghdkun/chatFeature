<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Domain\WhatsApp\Jobs\RunWhatsAppSessionStart;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaAddressRefused;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaNotConfigured;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Sleep;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Session management for administrators: create, start (webhook registered once, engine started by a job), stop, sync, QR, pacing and
 * delete, with OpenWA faked. Every failure of OpenWA is answered with a code of its own and leaves nothing half-done.
 */
class WhatsAppSessionApiTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = $this->whatsAppPeople()['admin'];
        Sleep::fake();
    }

    private function api(): self
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    // ---- create / list / show ----------------------------------------------------------------------------------------------

    public function test_an_administrator_creates_a_session_which_exists_at_openwa_and_here(): void
    {
        $response = $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main']);

        $response->assertCreated()
            ->assertJsonPath('data.name', 'support-main')
            ->assertJsonPath('data.status', 'created')
            ->assertJsonPath('data.webhookRegistered', false)
            ->assertJsonPath('data.qrAvailable', false);
        $this->openWa()->assertCalled('createSession', fn (array $args): bool => $args['name'] === 'support-main', 1);

        $session = WhatsAppSession::query()->sole();
        $this->assertNotNull($session->openwa_session_id);
        $this->assertSame('created', $session->status->value);
        $this->assertStringNotContainsString($session->openwa_session_id, $response->getContent(), 'the OpenWA id never leaves the server');

        $audit = AuditLog::query()->where('action', 'whatsapp.session.created')->sole();
        $this->assertSame($this->admin->id, $audit->actor_id);
    }

    /**
     * @return iterable<string, array{mixed}>
     */
    public static function badNames(): iterable
    {
        yield 'too short' => ['ab'];
        yield 'too long' => [str_repeat('a', 51)];
        yield 'a space' => ['my bot'];
        yield 'an underscore' => ['my_bot'];
        yield 'unicode' => ['bötle'];
        yield 'markup' => ['<b>bold</b>'];
        yield 'empty' => [''];
        yield 'missing' => [null];
        yield 'an array' => [['x']];
    }

    #[DataProvider('badNames')]
    public function test_a_bad_name_is_a_validation_error_and_nothing_is_called(mixed $name): void
    {
        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => $name])->assertStatus(422)->assertJsonValidationErrors('name', 'error.details');

        $this->openWa()->assertNothingCalled();
        $this->assertSame(0, WhatsAppSession::query()->count());
    }

    public function test_a_name_already_used_by_a_live_session_is_refused_before_openwa_is_asked(): void
    {
        WhatsAppSession::factory()->create(['name' => 'support-main']);

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertStatus(409)->assertJsonPath('error.code', 'session_name_taken');

        $this->openWa()->assertNothingCalled();
    }

    public function test_the_name_of_a_deleted_session_can_be_used_again(): void
    {
        WhatsAppSession::factory()->create(['name' => 'support-main'])->delete();

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertCreated();
    }

    public function test_a_name_openwa_already_has_is_a_conflict_and_leaves_no_local_row(): void
    {
        $this->openWa()->withSession($this->openWa()->makeSession('00000000-0000-4000-8000-0000000000aa', SessionStatus::Created, 'support-main'));

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertStatus(409)->assertJsonPath('error.code', 'openwa_session_exists');

        $this->assertSame(0, WhatsAppSession::query()->count());
    }

    public function test_a_name_openwa_is_still_tearing_down_is_retried_and_then_works(): void
    {
        $teardown = new OpenWaRejected('SESSION_NAME_TEARDOWN_PENDING', 409, 'teardown in flight');
        $this->openWa()->willThrow('createSession', $teardown, 2);

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertCreated();

        $this->assertCount(3, $this->openWa()->calls('createSession'));
        Sleep::assertSequence([Sleep::for(1)->seconds(), Sleep::for(2)->seconds()]);
    }

    public function test_a_name_that_stays_torn_down_pending_asks_the_administrator_to_try_again(): void
    {
        $this->openWa()->willThrow('createSession', new OpenWaRejected('SESSION_NAME_TEARDOWN_PENDING', 409, 'teardown in flight'), null);

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertStatus(409)->assertJsonPath('error.code', 'session_name_teardown_pending');

        $this->assertSame(0, WhatsAppSession::query()->count());
    }

    /**
     * @return iterable<string, array{Throwable, int, string}>
     */
    public static function openWaFailures(): iterable
    {
        yield 'unreachable' => [new OpenWaUnavailable('OpenWA could not be reached.'), 503, 'openwa_unavailable'];
        yield 'not configured' => [new OpenWaNotConfigured('no key'), 409, 'openwa_not_configured'];
        yield 'address refused' => [new OpenWaAddressRefused('no'), 503, 'openwa_unavailable'];
        yield 'key refused is never a 401' => [new OpenWaRejected('unauthorized', 401, 'Invalid API key'), 502, 'openwa_unauthorized'];
        yield 'role too low is never a 403' => [new OpenWaRejected('forbidden', 403, 'Insufficient permissions'), 502, 'openwa_unauthorized'];
        yield 'anything else' => [new OpenWaRejected('bad_request', 400, 'name is wrong'), 502, 'openwa_rejected'];
    }

    #[DataProvider('openWaFailures')]
    public function test_every_failure_of_openwa_gets_its_own_code_and_leaves_nothing_behind(\Throwable $failure, int $status, string $code): void
    {
        $this->openWa()->willThrow('createSession', $failure);

        $response = $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertStatus($status)->assertJsonPath('error.code', $code);

        $this->assertSame(0, WhatsAppSession::query()->count());
        $this->assertStringNotContainsString('owa_k1', $response->getContent());
    }

    public function test_the_list_names_live_sessions_oldest_first_with_the_widgets_that_use_them(): void
    {
        $first = WhatsAppSession::factory()->ready()->create(['name' => 'support-a']);
        WhatsAppSession::factory()->create(['name' => 'support-b']);
        WhatsAppSession::factory()->create(['name' => 'support-gone'])->delete();
        Widget::factory()->withWhatsAppSession($first)->create();

        $response = $this->api()->getJson('/api/v1/whatsapp/sessions')->assertOk();

        $this->assertSame(['support-a', 'support-b'], array_column($response->json('data'), 'name'));
        $this->assertSame(1, $response->json('data.0.linkedWidgetsCount'));
        $this->assertTrue($response->json('data.0.isLinkedToWidgets'));
        $this->assertNull($response->json('meta.next_cursor'));
    }

    public function test_no_response_ever_carries_a_secret_an_openwa_id_or_the_qr_image(): void
    {
        $session = WhatsAppSession::factory()->qr()->withWebhook('super-secret-webhook-secret-0123456789-abcd')->create(['name' => 'support-a']);

        foreach (['/api/v1/whatsapp/sessions', '/api/v1/whatsapp/sessions/'.$session->ulid] as $uri) {
            $body = $this->api()->getJson($uri)->assertOk()->getContent();

            $this->assertStringNotContainsString('super-secret-webhook-secret', $body);
            $this->assertStringNotContainsString((string) $session->openwa_session_id, $body);
            $this->assertStringNotContainsString((string) $session->openwa_webhook_id, $body);
            $this->assertStringNotContainsString('iVBOR', $body);
            $this->assertStringNotContainsString('webhook_secret', $body);
        }
    }

    public function test_an_unknown_or_deleted_session_is_404(): void
    {
        $gone = WhatsAppSession::factory()->create();
        $gone->delete();

        $this->api()->getJson('/api/v1/whatsapp/sessions/01J9ZZZZZZZZZZZZZZZZZZZZZZ')->assertNotFound();
        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$gone->ulid)->assertNotFound();
        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$gone->ulid.'/start')->assertNotFound();
        $this->api()->getJson('/api/v1/whatsapp/sessions/not-a-ulid')->assertNotFound();
    }

    // ---- start -------------------------------------------------------------------------------------------------------------

    public function test_start_registers_the_webhook_once_and_hands_the_engine_start_to_a_job(): void
    {
        Queue::fake();
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b1', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        Event::fake([WaSessionStatusChanged::class]);

        $response = $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $response->assertJsonPath('data.status', 'starting')->assertJsonPath('data.webhookRegistered', true);
        $session->refresh();
        $this->assertSame(SessionStatus::Starting, $session->status);
        $this->assertNotNull($session->openwa_webhook_id);
        $this->assertGreaterThanOrEqual(40, strlen((string) $session->webhook_secret));
        $this->assertStringNotContainsString((string) $session->webhook_secret, $response->getContent());
        $this->assertStringNotContainsString((string) $session->webhook_secret_encrypted, $response->getContent());

        $openWa->assertCalled('registerWebhook', function (array $args) use ($session, $remote): bool {
            return $args['sessionId'] === $remote->id
                && $args['url'] === $session->webhookUrl()
                && $args['secret'] === $session->webhook_secret
                && $args['events'] === config('whatsapp.webhook_events')
                && in_array('message.received', $args['events'], true) && in_array('message.ack', $args['events'], true);
        }, 1);
        $this->assertStringContainsString('/webhooks/openwa/'.$session->ulid, $session->webhookUrl());
        $this->assertStringNotContainsString('@', $session->webhookUrl(), 'no credentials in the URL');
        Event::assertDispatched(WaSessionStatusChanged::class, fn (WaSessionStatusChanged $event): bool => $event->from === SessionStatus::Created);
        Queue::assertPushed(RunWhatsAppSessionStart::class, 1);
        $openWa->assertNotCalled('startSession');

        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.session.started')->count());
    }

    public function test_the_job_starts_the_engine_and_the_session_follows_what_openwa_says(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b2', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->will('startSession', $openWa->makeSession($remote->id, SessionStatus::Qr, 'support-main'));

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $openWa->assertCalled('startSession', fn (array $args): bool => $args['sessionId'] === $remote->id, 1);
        $this->assertSame(SessionStatus::Qr, $session->refresh()->status, 'sync queue: the job already ran');
    }

    public function test_the_webhook_is_registered_only_once_over_several_starts(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b3', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);
        $secret = $session->refresh()->webhook_secret;
        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/stop')->assertOk();
        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $openWa->assertCalled('registerWebhook', null, 1);
        $this->assertSame($secret, $session->refresh()->webhook_secret, 'the secret never changes under a registered webhook');
    }

    public function test_a_session_that_is_already_running_cannot_be_started_again(): void
    {
        foreach (['starting', 'qr', 'ready'] as $state) {
            $session = WhatsAppSession::factory()->{$state}()->create();

            $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(409)
                ->assertJsonPath('error.code', 'session_not_startable')->assertJsonPath('error.details.status', $state);
        }

        $this->openWa()->assertNothingCalled();
    }

    public function test_a_failed_or_stopped_session_can_be_started_again_and_the_old_error_goes(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b4', SessionStatus::Failed, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->failed('The engine did not finish starting.')->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $this->assertNull($session->refresh()->last_error);
    }

    public function test_when_openwa_lost_the_session_start_creates_it_again_and_registers_a_fresh_webhook(): void
    {
        // The factory's OpenWA id is unknown to the fake: OpenWA "restarted without its data".
        $session = WhatsAppSession::factory()->failed()->create(['name' => 'support-main']);
        $oldId = $session->openwa_session_id;
        $oldWebhook = $session->openwa_webhook_id;

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $session->refresh();
        $this->assertNotSame($oldId, $session->openwa_session_id);
        $this->assertNotSame($oldWebhook, $session->openwa_webhook_id);
        $this->openWa()->assertCalled('createSession', fn (array $args): bool => $args['name'] === 'support-main', 1);
        $this->openWa()->assertCalled('registerWebhook', fn (array $args): bool => $args['sessionId'] === $session->openwa_session_id, 1);
    }

    /**
     * @return iterable<string, array{string, bool}>
     */
    public static function webhookRefusals(): iterable
    {
        // The real text of OpenWA's SSRF guard (recorded), and the bare body production answers with.
        yield 'the SSRF guard' => ['Destination address is not allowed', true];
        yield 'a bare 400' => ['Bad Request', true];
        yield 'an empty message' => ['', true];
        yield 'something else' => ['Webhook URL must not contain credentials (userinfo)', false];
    }

    #[DataProvider('webhookRefusals')]
    public function test_a_webhook_address_openwa_refuses_is_explained(string $message, bool $hint): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b5', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->willThrow('registerWebhook', new OpenWaRejected('bad_request', 400, $message));

        $response = $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(422)->assertJsonPath('error.code', 'webhook_rejected');

        $text = $response->json('error.message');
        $this->assertStringContainsString($session->webhookUrl(), $text);
        $this->assertSame($hint, str_contains($text, 'SSRF_ALLOWED_HOSTS'));

        if ($hint) {
            $this->assertStringContainsString('host.docker.internal', $text);
            $this->assertStringContainsString('redirect', $text);
            $this->assertStringContainsString('127.0.0.1', $response->json('error.details.host'));
        } else {
            $this->assertStringContainsString($message, $text);
        }

        $session->refresh();
        $this->assertSame(SessionStatus::Created, $session->status, 'nothing moved');
        $this->assertNull($session->openwa_webhook_id);
        $this->assertNull($session->webhook_registered_at);
        $openWa->assertNotCalled('startSession');
    }

    public function test_the_per_session_webhook_limit_is_its_own_error(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b8', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->willThrow('registerWebhook', new OpenWaRejected('bad_request', 400, 'Webhook limit reached for this session (16/16); delete one before registering another'));

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(409)->assertJsonPath('error.code', 'webhook_limit_reached');
    }

    public function test_a_start_that_cannot_reach_openwa_is_answered_and_changes_nothing(): void
    {
        $session = WhatsAppSession::factory()->create();
        $this->openWa()->willThrow('getSession', new OpenWaUnavailable('OpenWA could not be reached.'));

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(503)->assertJsonPath('error.code', 'openwa_unavailable');

        $this->assertSame(SessionStatus::Created, $session->refresh()->status);
    }

    public function test_when_the_engine_cannot_start_the_session_ends_failed_with_a_reason(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b6', SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->willThrow('startSession', new OpenWaUnavailable('OpenWA answered HTTP 504.'));

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $session->refresh();
        $this->assertSame(SessionStatus::Failed, $session->status);
        $this->assertStringContainsString('OpenWA answered HTTP 504', (string) $session->last_error);
    }

    public function test_an_already_started_engine_is_reconciled_instead_of_failing(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000b7', SessionStatus::Ready, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $openWa->willThrow('startSession', new OpenWaRejected('bad_request', 400, 'Session already started'));

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202);

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('+4915100000000', $session->phone_e164);
    }

    // ---- stop / sync -------------------------------------------------------------------------------------------------------

    public function test_stop_takes_a_running_session_down(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000c1', SessionStatus::Ready, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/stop')->assertOk()->assertJsonPath('data.status', 'disconnected');

        $this->assertSame(SessionStatus::Disconnected, $session->refresh()->status);
        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.session.stopped')->count());
    }

    public function test_a_session_that_is_not_running_cannot_be_stopped(): void
    {
        $session = WhatsAppSession::factory()->disconnected()->create();

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/stop')->assertStatus(409)->assertJsonPath('error.code', 'session_not_stoppable');
    }

    public function test_stopping_a_session_openwa_no_longer_knows_just_marks_it_down(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/stop')->assertOk();

        $this->assertSame(SessionStatus::Disconnected, $session->refresh()->status);
    }

    public function test_sync_writes_what_openwa_reports(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000c2', SessionStatus::Ready, 'support-main', ['pushName' => 'Support Desk']);
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/sync')->assertOk()->assertJsonPath('data.status', 'ready');

        $session->refresh();
        $this->assertSame('+4915100000000', $session->phone_e164);
        $this->assertSame('Support Desk', $session->push_name);
        $this->assertNotNull($session->ready_at);
    }

    public function test_sync_marks_a_session_openwa_does_not_know_as_failed(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/sync')->assertOk()->assertJsonPath('data.status', 'failed');

        $this->assertStringContainsString('no longer knows', (string) $session->refresh()->last_error);
    }

    public function test_sync_fetches_a_missing_qr_for_a_session_waiting_for_a_scan(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000c3', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/sync')->assertOk()->assertJsonPath('data.qrAvailable', true);

        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $session->refresh()->last_qr);
    }

    // ---- QR ----------------------------------------------------------------------------------------------------------------

    public function test_the_qr_is_served_without_a_call_while_it_is_fresh_and_is_never_cached(): void
    {
        $session = WhatsAppSession::factory()->qr()->create();

        $response = $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertOk();

        $response->assertJsonPath('data.qr', WhatsAppSessionFactory::FAKE_QR);
        $this->assertNotNull($response->json('data.updatedAt'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->openWa()->assertNothingCalled();
    }

    public function test_a_stale_qr_is_fetched_from_openwa_and_stored(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d1', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'last_qr' => null, 'last_qr_at' => null]);

        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertOk()->assertJsonPath('data.qr', WhatsAppSessionFactory::FAKE_QR);

        $openWa->assertCalled('getQr', null, 1);
        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $session->refresh()->last_qr);
    }

    public function test_the_qr_exists_only_while_the_session_waits_for_a_scan(): void
    {
        foreach (['created', 'starting', 'ready', 'disconnected', 'failed'] as $state) {
            $session = $state === 'created' ? WhatsAppSession::factory()->create() : WhatsAppSession::factory()->{$state}()->create();

            $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertStatus(409)
                ->assertJsonPath('error.code', 'qr_not_available')->assertJsonPath('error.details.status', $state);
        }

        $this->openWa()->assertNothingCalled();
    }

    public function test_openwas_throttle_serves_the_last_known_qr_or_says_to_retry_shortly(): void
    {
        $throttle = new OpenWaRejected('rate_limited', 429, 'ThrottlerException: Too Many Requests');

        // A QR we already have (older than the fresh window): served instead of the error.
        $known = WhatsAppSession::factory()->qr()->create(['last_qr_at' => now()->subSeconds(50)]);
        $this->openWa()->willThrow('getQr', $throttle);
        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$known->ulid.'/qr')->assertOk()->assertJsonPath('data.qr', WhatsAppSessionFactory::FAKE_QR);

        // None at all yet: a retry hint, never a 5xx and never a dashboard logout.
        $none = WhatsAppSession::factory()->qr()->create(['last_qr' => null, 'last_qr_at' => null]);
        $this->openWa()->willThrow('getQr', $throttle);
        $response = $this->api()->getJson('/api/v1/whatsapp/sessions/'.$none->ulid.'/qr')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->assertSame('2', $response->headers->get('Retry-After'));
    }

    public function test_openwas_plain_throttle_on_an_admin_action_is_a_retry_hint(): void
    {
        $this->openWa()->willThrow('createSession', new OpenWaRejected('rate_limited', 429, 'ThrottlerException: Too Many Requests'));

        $this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        $this->assertSame(0, WhatsAppSession::query()->count());
    }

    public function test_a_qr_older_than_the_fresh_window_is_fetched_but_a_fresh_one_is_not(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000d2', SessionStatus::Qr, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id, 'last_qr_at' => now()->subSeconds(40)]);

        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertOk();
        $openWa->assertNotCalled('getQr');

        $session->forceFill(['last_qr_at' => now()->subSeconds(50)])->save();
        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertOk();
        $openWa->assertCalled('getQr', null, 1);
    }

    public function test_a_qr_openwa_is_not_ready_to_give_is_a_409_not_a_failure(): void
    {
        $session = WhatsAppSession::factory()->qr()->create(['last_qr' => null, 'last_qr_at' => null]);
        $this->openWa()->willThrow('getQr', new OpenWaRejected('bad_request', 400, 'QR not ready'));

        $this->api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertStatus(409)->assertJsonPath('error.code', 'qr_not_available');
    }

    // ---- pacing / delete ---------------------------------------------------------------------------------------------------

    public function test_pacing_overrides_are_set_and_removed_per_session(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        $this->api()->patchJson('/api/v1/whatsapp/sessions/'.$session->ulid, ['send_min_interval_ms' => 4000, 'daily_send_cap' => 50])
            ->assertOk()->assertJsonPath('data.sendMinIntervalMs', 4000)->assertJsonPath('data.dailySendCap', 50)->assertJsonPath('data.pacingOverridden', true);

        $this->api()->patchJson('/api/v1/whatsapp/sessions/'.$session->ulid, ['daily_send_cap' => null])
            ->assertOk()->assertJsonPath('data.sendMinIntervalMs', 4000)->assertJsonPath('data.dailySendCap', 200);

        $this->api()->patchJson('/api/v1/whatsapp/sessions/'.$session->ulid, ['send_min_interval_ms' => null])
            ->assertOk()->assertJsonPath('data.sendMinIntervalMs', 1500)->assertJsonPath('data.pacingOverridden', false);
        $this->assertNull($session->refresh()->settings);
    }

    public function test_pacing_values_are_range_checked(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        foreach ([['send_min_interval_ms' => -1], ['send_min_interval_ms' => 60001], ['daily_send_cap' => 0], ['daily_send_cap' => 10001], ['daily_send_cap' => 'many']] as $body) {
            $this->api()->patchJson('/api/v1/whatsapp/sessions/'.$session->ulid, $body)->assertStatus(422);
        }
    }

    public function test_delete_removes_the_session_at_openwa_and_soft_deletes_it_here_keeping_the_history(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000e1', SessionStatus::Ready, 'support-main');
        $openWa->withSession($remote);
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);
        $chat = WaChat::factory()->for($session, 'session')->create();
        $widget = Widget::factory()->withWhatsAppSession($session)->create();

        $this->api()->deleteJson('/api/v1/whatsapp/sessions/'.$session->ulid)->assertNoContent();

        $openWa->assertCalled('deleteSession', fn (array $args): bool => $args['sessionId'] === $remote->id, 1);
        $trashed = WhatsAppSession::withTrashed()->findOrFail($session->id);
        $this->assertTrue($trashed->trashed());
        $this->assertNull($trashed->webhook_secret, 'the secret is dropped with the session');
        $this->assertNull($trashed->openwa_session_id);
        $this->assertNull($trashed->last_qr);
        $this->assertTrue(WaChat::query()->whereKey($chat->id)->exists(), 'the history stays');
        $this->assertNull($widget->refresh()->whatsappSession, 'a linked widget behaves as unlinked');
        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.session.deleted')->count());
        $this->assertSame(0, WhatsAppSession::query()->count());
    }

    public function test_a_session_openwa_does_not_know_is_deleted_here_all_the_same(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        $this->api()->deleteJson('/api/v1/whatsapp/sessions/'.$session->ulid)->assertNoContent();

        $this->assertTrue($session->refresh()->trashed());
    }

    public function test_an_unreachable_openwa_blocks_a_delete_unless_it_is_forced(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $this->openWa()->willThrow('deleteSession', new OpenWaUnavailable('down'), null);

        $this->api()->deleteJson('/api/v1/whatsapp/sessions/'.$session->ulid)->assertStatus(503);
        $this->assertFalse($session->refresh()->trashed());

        $this->api()->deleteJson('/api/v1/whatsapp/sessions/'.$session->ulid.'?force=1')->assertNoContent();
        $this->assertTrue($session->refresh()->trashed());
        $audit = AuditLog::query()->where('action', 'whatsapp.session.deleted')->sole();
        $this->assertTrue($audit->changes['forced']);
    }

    public function test_deleting_while_openwa_tears_down_retries_then_gives_up_with_a_hint(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $this->openWa()->willThrow('deleteSession', new OpenWaRejected('SESSION_NAME_TEARDOWN_PENDING', 409, 'teardown'), null);

        $this->api()->deleteJson('/api/v1/whatsapp/sessions/'.$session->ulid)->assertStatus(409)->assertJsonPath('error.code', 'session_name_teardown_pending');

        $this->assertFalse($session->refresh()->trashed());
    }
}
