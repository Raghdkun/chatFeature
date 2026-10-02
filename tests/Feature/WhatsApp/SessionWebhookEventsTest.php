<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Events\WaSessionQrUpdated;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Domain\WhatsApp\Jobs\RunWhatsAppSessionStart;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\OpenWaFixtures;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The `session.*` webhooks drive the session's status machine with OpenWA's wire values, store a QR encrypted and keep the number,
 * push name and last error; out-of-order and repeated events are safe.
 */
class SessionWebhookEventsTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures;

    /**
     * @return iterable<string, array{string, SessionStatus}>
     */
    public static function wireStatuses(): iterable
    {
        yield 'initializing' => ['initializing', SessionStatus::Starting];
        yield 'authenticating' => ['authenticating', SessionStatus::Starting];
        yield 'qr_ready' => ['qr_ready', SessionStatus::Qr];
        yield 'ready' => ['ready', SessionStatus::Ready];
        yield 'disconnected' => ['disconnected', SessionStatus::Disconnected];
        yield 'action_required' => ['action_required', SessionStatus::Failed];
        yield 'failed' => ['failed', SessionStatus::Failed];
    }

    #[DataProvider('wireStatuses')]
    public function test_session_status_maps_the_wire_value_and_announces_the_change(string $wire, SessionStatus $expected): void
    {
        $session = $this->webhookSession(state: 'starting');
        Event::fake([WaSessionStatusChanged::class]);

        $this->deliver($session, $this->envelope('session.status', ['sessionId' => 'support-main', 'status' => $wire]))->assertOk();

        $this->assertSame($expected, $session->refresh()->status);

        if ($expected !== SessionStatus::Starting) {
            Event::assertDispatched(WaSessionStatusChanged::class, fn (WaSessionStatusChanged $event): bool => $event->session->is($session) && $event->from === SessionStatus::Starting);
        }
    }

    public function test_an_unknown_status_keeps_the_status_and_is_ignored(): void
    {
        $session = $this->webhookSession(state: 'ready');

        $this->deliver($session, $this->envelope('session.status', ['status' => 'teleporting']))->assertOk();

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);
    }

    public function test_a_repeated_status_writes_and_announces_nothing(): void
    {
        $session = $this->webhookSession(state: 'ready');
        $updated = $session->updated_at;
        Event::fake([WaSessionStatusChanged::class]);

        $this->travel(1)->minutes();
        $this->deliver($session, $this->envelope('session.status', ['status' => 'ready']))->assertOk();

        Event::assertNotDispatched(WaSessionStatusChanged::class);
        $this->assertEquals($updated, $session->refresh()->updated_at);
    }

    public function test_a_move_the_table_does_not_know_is_still_applied_because_openwa_is_the_source_of_truth(): void
    {
        $session = $this->webhookSession(state: 'failed');

        $this->deliver($session, $this->envelope('session.status', ['status' => 'ready']))->assertOk();

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
        $this->assertNotNull($session->ready_at);
        $this->assertNull($session->last_error, 'ready clears the error');
    }

    public function test_a_qr_is_stored_encrypted_moves_the_session_to_qr_and_is_announced_without_the_image(): void
    {
        $session = $this->webhookSession(state: 'starting');
        Event::fake([WaSessionQrUpdated::class, WaSessionStatusChanged::class]);

        $this->deliver($session, $this->envelope('session.qr', ['sessionId' => 'support-main', 'qr' => WhatsAppSessionFactory::FAKE_QR]))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Qr, $session->status);
        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $session->last_qr);
        $this->assertNotNull($session->last_qr_at);
        $this->assertStringNotContainsString('iVBOR', (string) $session->getRawOriginal('last_qr'), 'the image is encrypted at rest');
        Event::assertDispatched(WaSessionQrUpdated::class);
        Event::assertDispatched(WaSessionStatusChanged::class, fn (WaSessionStatusChanged $event): bool => $event->from === SessionStatus::Starting);
    }

    public function test_a_new_qr_replaces_the_old_one_without_a_status_change(): void
    {
        $session = $this->webhookSession(state: 'qr');
        Event::fake([WaSessionQrUpdated::class, WaSessionStatusChanged::class]);

        $this->deliver($session, $this->envelope('session.qr', ['qr' => OpenWaFixtures::PNG_DATA_URL]))->assertOk();

        $this->assertSame(OpenWaFixtures::PNG_DATA_URL, $session->refresh()->last_qr);
        Event::assertDispatched(WaSessionQrUpdated::class);
        Event::assertNotDispatched(WaSessionStatusChanged::class);
    }

    /**
     * @return iterable<string, array{mixed}>
     */
    public static function badQrs(): iterable
    {
        yield 'a url' => ['https://evil.test/qr.png'];
        yield 'svg' => ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='];
        yield 'script in the png slot' => ['data:image/png;base64,"><script>alert(1)</script>'];
        yield 'not a string' => [['x']];
        yield 'missing' => [null];
    }

    #[DataProvider('badQrs')]
    public function test_a_qr_that_is_not_a_png_data_url_is_never_stored(mixed $qr): void
    {
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->envelope('session.qr', ['qr' => $qr]))->assertOk();

        $session->refresh();
        $this->assertNull($session->last_qr);
        $this->assertSame(SessionStatus::Starting, $session->status);
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);
    }

    public function test_leaving_the_qr_state_drops_the_image(): void
    {
        $session = $this->webhookSession(state: 'qr');

        $this->deliver($session, $this->envelope('session.status', ['status' => 'authenticating']))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Starting, $session->status);
        $this->assertNull($session->last_qr);
        $this->assertNull($session->last_qr_at);
    }

    public function test_authenticated_makes_the_session_ready_with_its_number_and_name(): void
    {
        $session = $this->webhookSession(state: 'qr');

        $this->deliver($session, $this->envelope('session.authenticated', ['sessionId' => 'support-main', 'phone' => '6281234567890', 'pushName' => "Support\nTeam"]))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('+6281234567890', $session->phone_e164);
        $this->assertSame('Support Team', $session->push_name);
        $this->assertNotNull($session->ready_at);
        $this->assertNull($session->last_qr);
    }

    public function test_disconnected_records_the_reason(): void
    {
        $session = $this->webhookSession(state: 'ready');

        $this->deliver($session, $this->envelope('session.disconnected', ['sessionId' => 'support-main', 'reason' => 'LOGOUT']))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Disconnected, $session->status);
        $this->assertSame('Disconnected: LOGOUT', $session->last_error);
    }

    public function test_a_reconnect_loop_keeps_the_status_and_says_what_is_going_on(): void
    {
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->envelope('session.reconnect_loop', ['sessionId' => 'support-main', 'attempts' => 10, 'nextDelayMs' => 30000]))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Starting, $session->status);
        $this->assertSame('WhatsApp keeps dropping the connection (attempt 10), next try in 30 s.', $session->last_error);
    }

    public function test_events_of_a_deleted_session_are_not_delivered_at_all(): void
    {
        $session = $this->webhookSession(state: 'ready');
        $session->delete();

        $this->deliver($session, $this->envelope('session.status', ['status' => 'disconnected']))->assertNotFound();

        $this->assertSame(SessionStatus::Ready, WhatsAppSession::withTrashed()->find($session->id)->status);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function unhandledEvents(): iterable
    {
        yield 'revoked' => ['message.revoked'];
        yield 'reaction' => ['message.reaction'];
        yield 'edited' => ['message.edited'];
        yield 'presence' => ['presence.update'];
        yield 'call' => ['call.received'];
        yield 'group' => ['group.join'];
        yield 'status story' => ['status.received'];
        yield 'restriction' => ['session.restriction'];
        yield 'something new' => ['brand.new_event'];
    }

    #[DataProvider('unhandledEvents')]
    public function test_every_other_event_is_acknowledged_and_ignored(string $event): void
    {
        $session = $this->webhookSession(state: 'ready');

        $this->deliver($session, $this->envelope($event, ['anything' => 'goes', 'nested' => ['a' => 1]]))->assertOk()->assertExactJson(['status' => 'accepted']);

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame(WebhookOutcome::Ignored, $delivery->outcome);
        $this->assertSame($event, $delivery->event);
        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    public function test_a_signed_body_without_an_event_is_refused_whatever_the_unsigned_header_says(): void
    {
        $session = $this->webhookSession(state: 'qr');
        $body = $this->envelope('session.status', ['status' => 'ready']);
        unset($body['event']);

        // The headers are not covered by the signature: `X-OpenWA-Event` is never trusted.
        $this->deliver($session, $body, headers: ['X-OpenWA-Event' => 'session.status'])->assertStatus(400)->assertJsonPath('error.code', 'invalid_webhook');

        $this->assertSame(SessionStatus::Qr, $session->refresh()->status);
        $this->assertSame(0, WaWebhookDelivery::query()->count());
    }

    public function test_an_unusable_event_name_in_the_body_is_refused(): void
    {
        $session = $this->webhookSession(state: 'qr');

        foreach ([null, '', 42, ['session.status'], str_repeat('a', 49), 'session status', "session.status\nX", '.hidden'] as $event) {
            $body = $this->envelope('session.status', ['status' => 'ready']);
            $body['event'] = $event;

            $this->deliver($session, $body, headers: ['X-OpenWA-Event' => 'session.status'])->assertStatus(400);
        }

        $this->assertSame(SessionStatus::Qr, $session->refresh()->status);
        $this->assertSame(0, WaWebhookDelivery::query()->count());
    }

    public function test_the_event_is_read_from_the_body_even_when_the_header_names_another_one(): void
    {
        $session = $this->webhookSession(state: 'qr');

        $this->deliver($session, $this->envelope('session.status', ['status' => 'ready']), headers: ['X-OpenWA-Event' => 'message.received'])->assertOk();

        $this->assertSame('session.status', WaWebhookDelivery::query()->sole()->event);
        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    // ---- ordering ----------------------------------------------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    private function statusAt(string $status, string $when): array
    {
        return ['timestamp' => $when] + $this->envelope('session.status', ['status' => $status]);
    }

    public function test_an_older_event_that_overtook_a_newer_one_is_not_applied(): void
    {
        $session = $this->webhookSession(state: 'starting');

        // Deliveries are independent and not ordered (recorded): `ready` raised at :05.000 arrives before the `qr_ready` raised at :04.500.
        $this->deliver($session, $this->statusAt('ready', '2026-10-02T02:11:05.000Z'))->assertOk();
        $this->deliver($session, $this->statusAt('qr_ready', '2026-10-02T02:11:04.500Z'))->assertOk();

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
        $outcomes = WaWebhookDelivery::query()->orderBy('id')->get();
        $this->assertSame(WebhookOutcome::Processed, $outcomes[0]->outcome);
        $this->assertSame(WebhookOutcome::Ignored, $outcomes[1]->outcome);
        $this->assertSame('Older than what was already applied to this session.', $outcomes[1]->error);
    }

    public function test_events_of_the_same_moment_and_newer_ones_apply(): void
    {
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->statusAt('qr_ready', '2026-10-02T02:11:05.000Z'))->assertOk();
        $this->deliver($session, $this->statusAt('authenticating', '2026-10-02T02:11:05.000Z'))->assertOk();
        $this->assertSame(SessionStatus::Starting, $session->refresh()->status);

        $this->deliver($session, $this->statusAt('ready', '2026-10-02T02:11:06.000Z'))->assertOk();
        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    public function test_a_stale_qr_never_undoes_a_session_that_became_ready(): void
    {
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->statusAt('ready', '2026-10-02T02:11:05.000Z'))->assertOk();
        $this->deliver($session, ['timestamp' => '2026-10-02T02:11:04.900Z'] + $this->envelope('session.qr', ['qr' => OpenWaFixtures::PNG_DATA_URL]))->assertOk();

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertNull($session->last_qr);
    }

    public function test_each_session_has_its_own_clock(): void
    {
        $one = $this->webhookSession(state: 'starting');
        $two = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02', 'starting');

        $this->deliver($one, $this->statusAt('ready', '2026-10-02T02:11:05.000Z'))->assertOk();
        $this->deliver($two, $this->statusAt('qr_ready', '2026-10-02T02:11:01.000Z'))->assertOk();

        $this->assertSame(SessionStatus::Qr, $two->refresh()->status);
    }

    public function test_the_answer_of_a_blocked_start_call_never_overwrites_what_a_webhook_said_meanwhile(): void
    {
        $openWa = $this->openWa();
        $session = $this->webhookSession(state: 'qr');
        $session->forceFill(['status' => SessionStatus::Starting, 'last_qr' => null, 'last_qr_at' => null])->save();
        $remote = $openWa->makeSession((string) $session->openwa_session_id, SessionStatus::Created, 'support-main');
        $openWa->withSession($remote);

        // The start call blocks; while it runs the QR was scanned and `ready` arrived. Its answer, built earlier, still says `qr_ready`.
        $openWa->will('startSession', function () use ($session, $openWa, $remote) {
            $this->deliver($session, $this->statusAt('ready', now()->toIso8601ZuluString('millisecond')))->assertOk();

            return $openWa->makeSession($remote->id, SessionStatus::Qr, 'support-main');
        });

        (new RunWhatsAppSessionStart($session->id))->handle($openWa, app(ApplySessionState::class));

        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    public function test_the_answer_of_the_start_call_does_move_a_session_that_is_still_starting(): void
    {
        $openWa = $this->openWa();
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main']);
        $openWa->withSession($openWa->makeSession((string) $session->openwa_session_id, SessionStatus::Created, 'support-main'));
        $openWa->will('startSession', $openWa->makeSession((string) $session->openwa_session_id, SessionStatus::Qr, 'support-main'));

        (new RunWhatsAppSessionStart($session->id))->handle($openWa, app(ApplySessionState::class));

        $this->assertSame(SessionStatus::Qr, $session->refresh()->status);
    }

    public function test_a_failed_start_does_not_fail_a_session_that_a_webhook_already_moved(): void
    {
        $openWa = $this->openWa();
        $session = $this->webhookSession(state: 'starting');
        $openWa->will('startSession', function () use ($session) {
            $this->deliver($session, $this->statusAt('qr_ready', now()->toIso8601ZuluString('millisecond')))->assertOk();

            throw new OpenWaUnavailable('OpenWA answered HTTP 504.');
        });

        (new RunWhatsAppSessionStart($session->id))->handle($openWa, app(ApplySessionState::class));

        $this->assertSame(SessionStatus::Qr, $session->refresh()->status, 'OpenWA said qr_ready: the call timing out afterwards changes nothing');
    }
}
