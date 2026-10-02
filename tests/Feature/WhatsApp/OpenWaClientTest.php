<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\NullOpenWaClient;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Infrastructure\OpenWa\OpenWaHttpClient;
use App\Models\WaMessage;
use Closure;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\AssertionFailedError;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeOpenWaClient;
use Tests\Support\FakeWaMediaUrls;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The OpenWA seam: the default binding that refuses to touch a network, the in-memory fake the suite uses, and the media URL signer.
 */
class OpenWaClientTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures;

    // ---- the default binding -----------------------------------------------------------------------------------------------

    public function test_tests_get_the_in_memory_fake_and_fake_media_urls(): void
    {
        $this->assertInstanceOf(FakeOpenWaClient::class, app(OpenWaClient::class));
        $this->assertSame(app(OpenWaClient::class), $this->openWa());
        $this->assertInstanceOf(FakeWaMediaUrls::class, app(WaMediaUrls::class));
    }

    /**
     * @return iterable<string, array{Closure(OpenWaClient): mixed}>
     */
    public static function everyCall(): iterable
    {
        yield 'ping' => [fn (OpenWaClient $c) => $c->ping()];
        yield 'createSession' => [fn (OpenWaClient $c) => $c->createSession('my-bot')];
        yield 'startSession' => [fn (OpenWaClient $c) => $c->startSession('id')];
        yield 'stopSession' => [fn (OpenWaClient $c) => $c->stopSession('id')];
        yield 'deleteSession' => [fn (OpenWaClient $c) => $c->deleteSession('id')];
        yield 'getSession' => [fn (OpenWaClient $c) => $c->getSession('id')];
        yield 'getQr' => [fn (OpenWaClient $c) => $c->getQr('id')];
        yield 'registerWebhook' => [fn (OpenWaClient $c) => $c->registerWebhook('id', 'https://x.test/hook', str_repeat('s', 20), ['message.received'])];
        yield 'deleteWebhook' => [fn (OpenWaClient $c) => $c->deleteWebhook('id', 'hook')];
        yield 'sendText' => [fn (OpenWaClient $c) => $c->sendText('id', '4915100000000@c.us', 'Hello')];
        yield 'downloadMedia' => [fn (OpenWaClient $c) => $c->downloadMedia('id', '4915100000000@c.us', 'message')];
    }

    public function test_the_default_binding_is_the_http_client(): void
    {
        $this->app->forgetInstance(OpenWaClient::class);
        $this->app->bind(OpenWaClient::class, OpenWaHttpClient::class);

        $this->assertInstanceOf(OpenWaHttpClient::class, app(OpenWaClient::class));
    }

    #[DataProvider('everyCall')]
    public function test_the_null_client_fails_loudly_and_touches_no_network(Closure $call): void
    {
        Http::fake();

        $client = new NullOpenWaClient;

        try {
            $call($client);
            $this->fail('the null client answered');
        } catch (OpenWaUnavailable $exception) {
            $this->assertSame('No OpenWA client is configured.', $exception->getMessage());
        }

        Http::assertNothingSent();
    }

    public function test_the_default_media_urls_are_signed_for_the_route_the_rest_track_registers(): void
    {
        $this->app->forgetInstance(WaMediaUrls::class);
        Route::get('/api/v1/whatsapp/media/{message}', fn (string $message): string => 'file '.$message)->name(SignedWaMediaUrls::ROUTE)->middleware('signed');
        Route::getRoutes()->refreshNameLookups(); // routes added after boot are not in the name lookup yet
        settings()->set('app.url', 'https://chat.example.com');
        $message = WaMessage::factory()->image()->create();

        $urls = app(WaMediaUrls::class);
        $this->assertInstanceOf(SignedWaMediaUrls::class, $urls);
        $url = $urls->url($message);

        $this->assertStringStartsWith('https://chat.example.com/api/v1/whatsapp/media/'.$message->ulid.'?', $url);
        $this->assertStringContainsString('signature=', $url);
        $this->assertStringContainsString('expires=', $url);
        $this->assertTrue(Request::create($url)->hasValidSignature(), 'the signature verifies');
        $this->assertFalse(Request::create($url.'x')->hasValidSignature(), 'and a tampered one does not');

        $this->get($url)->assertOk()->assertSee('file '.$message->ulid);
        $this->get(preg_replace('/signature=[^&]+/', 'signature=forged', $url) ?? '')->assertForbidden();
    }

    // ---- the fake ----------------------------------------------------------------------------------------------------------

    public function test_a_session_goes_through_create_start_qr_stop_and_delete(): void
    {
        $openWa = $this->openWa();

        $created = $openWa->createSession('support-main');
        $this->assertSame(SessionStatus::Created, $created->status);
        $this->assertSame('support-main', $created->name);
        $this->assertFalse($created->engineLoaded);

        $started = $openWa->startSession($created->id);
        $this->assertSame(SessionStatus::Starting, $started->status);
        $this->assertSame('initializing', $started->rawStatus, 'the wire value OpenWA would send');
        $this->assertTrue($started->engineLoaded);

        try {
            $openWa->getQr($created->id);
            $this->fail('a QR was rendered for a session that is not waiting for a scan');
        } catch (OpenWaRejected $exception) {
            $this->assertSame(400, $exception->status);
        }

        $openWa->withSession($openWa->makeSession($created->id, SessionStatus::Qr, 'support-main'));
        $qr = $openWa->getQr($created->id);
        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $qr->dataUrl);
        $this->assertSame(SessionStatus::Qr, $openWa->getSession($created->id)->status);

        $this->assertSame(SessionStatus::Disconnected, $openWa->stopSession($created->id)->status);

        $openWa->deleteSession($created->id);
        $this->expectException(OpenWaRejected::class);
        $openWa->getSession($created->id);
    }

    public function test_the_fake_refuses_what_openwa_refuses(): void
    {
        $openWa = $this->openWa();
        $openWa->createSession('taken-name');

        foreach ([
            fn () => $openWa->createSession('taken-name'),
            fn () => $openWa->createSession('ab'),
            fn () => $openWa->createSession('has space'),
            fn () => $openWa->startSession('unknown-id'),
            fn () => $openWa->registerWebhook('id', 'https://x.test/h', 'short', ['message.received']),
            fn () => $openWa->sendText('id', '4915100000000@c.us', ''),
            fn () => $openWa->sendText('id', '4915100000000@c.us', str_repeat('x', 4097)),
        ] as $call) {
            try {
                $call();
                $this->fail('the fake accepted something OpenWA refuses');
            } catch (OpenWaRejected $exception) {
                $this->assertGreaterThanOrEqual(400, $exception->status);
                $this->assertLessThan(500, $exception->status);
            }
        }
    }

    public function test_deleting_a_session_frees_its_name(): void
    {
        $openWa = $this->openWa();
        $first = $openWa->createSession('reusable');
        $openWa->deleteSession($first->id);

        $second = $openWa->createSession('reusable');

        $this->assertNotSame($first->id, $second->id);
    }

    public function test_sends_get_unique_whatsapp_ids_and_a_webhook_gets_an_id_and_no_secret(): void
    {
        $openWa = $this->openWa();

        $one = $openWa->sendText('s', '4915100000000@c.us', 'One');
        $two = $openWa->sendText('s', '4915100000000@c.us', 'Two');
        $this->assertInstanceOf(OpenWaSendResult::class, $one);
        $this->assertNotSame($one->messageId, $two->messageId);
        $this->assertStringStartsWith('true_4915100000000@c.us_', $one->messageId);

        $webhook = $openWa->registerWebhook('s', 'https://x.test/hook', str_repeat('s', 20), ['message.received', 'message.ack']);
        $this->assertNotSame('', $webhook->id);
        $this->assertSame(['message.received', 'message.ack'], $webhook->events);
        $this->assertNull($openWa->downloadMedia('s', '4915100000000@c.us', $one->messageId), 'nothing stored unless a test scripts it');
        $this->assertSame('operator', $openWa->ping()->role);
    }

    public function test_every_call_is_recorded_with_named_arguments(): void
    {
        $openWa = $this->openWa();
        $openWa->assertNothingCalled();

        $openWa->sendText('session-1', '4915100000000@c.us', 'Hello');
        $openWa->sendText('session-1', '4915100000001@c.us', 'Hi');
        $openWa->ping();

        $this->assertCount(3, $openWa->calls());
        $this->assertCount(2, $openWa->calls('sendText'));
        $this->assertSame(['sessionId' => 'session-1', 'chatId' => '4915100000000@c.us', 'text' => 'Hello'], $openWa->calls('sendText')[0]['args']);

        $openWa->assertCalled('sendText', times: 2);
        $openWa->assertCalled('sendText', fn (array $args): bool => $args['chatId'] === '4915100000001@c.us', times: 1);
        $openWa->assertNotCalled('deleteSession');
    }

    public function test_the_assertions_fail_when_they_should(): void
    {
        $openWa = $this->openWa();
        $openWa->ping();

        foreach ([
            fn () => $openWa->assertNothingCalled(),
            fn () => $openWa->assertNotCalled('ping'),
            fn () => $openWa->assertCalled('sendText'),
            fn () => $openWa->assertCalled('ping', fn (array $args): bool => false),
            fn () => $openWa->assertCalled('ping', times: 2),
        ] as $assertion) {
            try {
                $assertion();
                $this->fail('an assertion that must fail passed');
            } catch (AssertionFailedError $failure) {
                $this->assertNotSame('an assertion that must fail passed', $failure->getMessage());
            }
        }
    }

    public function test_a_call_can_be_scripted_to_fail_once_or_always(): void
    {
        $openWa = $this->openWa();
        $openWa->willThrow('sendText', new OpenWaPacingLimited(3600));

        try {
            $openWa->sendText('s', 'c@c.us', 'x');
            $this->fail('the scripted failure did not happen');
        } catch (OpenWaPacingLimited $exception) {
            $this->assertSame(3600, $exception->retryAfterSeconds);
        }

        $this->assertInstanceOf(OpenWaSendResult::class, $openWa->sendText('s', 'c@c.us', 'x'), 'once is once');

        $openWa->willThrow('ping', new OpenWaUnavailable('down'), times: null);
        foreach ([1, 2, 3] as $ignored) {
            try {
                $openWa->ping();
                $this->fail('the always-failing call answered');
            } catch (OpenWaUnavailable) {
                $this->addToAssertionCount(1);
            }
        }

        $this->assertCount(3, $openWa->calls('ping'), 'failed calls are recorded too');
    }

    public function test_a_call_can_be_scripted_with_a_value_a_sequence_or_a_closure(): void
    {
        $openWa = $this->openWa();
        $media = new OpenWaMedia('bytes', 'image/png', 'photo.png');
        $openWa->will('downloadMedia', $media);
        $openWa->will('downloadMedia', null);
        $openWa->will('sendText', fn (string $sessionId, string $chatId, string $text): OpenWaSendResult => new OpenWaSendResult('scripted-'.$text, now()->toImmutable()), times: null);

        $this->assertSame($media, $openWa->downloadMedia('s', 'c', 'm'));
        $this->assertNull($openWa->downloadMedia('s', 'c', 'm'));
        $this->assertSame('scripted-A', $openWa->sendText('s', 'c@c.us', 'A')->messageId);
        $this->assertSame('scripted-B', $openWa->sendText('s', 'c@c.us', 'B')->messageId);
    }
}
