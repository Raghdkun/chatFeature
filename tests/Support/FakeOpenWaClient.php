<?php

namespace Tests\Support;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaWebhook;
use Carbon\CarbonImmutable;
use Closure;
use Database\Factories\WhatsAppSessionFactory;
use PHPUnit\Framework\Assert;
use Throwable;

/**
 * An OpenWA that lives in memory (bound by `Tests\TestCase`, so no test reaches a network). It records every call and, unless a call
 * is scripted, answers like the real gateway would: sessions are created with a unique name (3-50 letters, digits, hyphens; a duplicate
 * is a `409`), start and stop change their status, an unknown session is a `404`, a webhook secret shorter than 16 characters is a
 * `400`, a send needs text of at most 4096 characters.
 *
 * Script a call with {@see self::will()} / {@see self::willThrow()}: the response is a value, a `Throwable` (thrown) or a `Closure`
 * called with the call's arguments, used once by default (`$times`) or for every call (`null`).
 *
 * ```php
 * $openWa = $this->openWa();
 * $openWa->willThrow('sendText', new OpenWaPacingLimited(3600));
 * ...
 * $openWa->assertCalled('sendText', fn (array $args): bool => $args['chatId'] === '4915...@c.us');
 * ```
 */
final class FakeOpenWaClient implements OpenWaClient
{
    /** @var list<array{method: string, args: array<string, mixed>}> */
    private array $calls = [];

    /** @var array<string, list<array{response: mixed, times: int|null}>> */
    private array $scripts = [];

    /** @var array<string, OpenWaSession> */
    private array $sessions = [];

    /** @var array<string, bool> */
    private array $names = [];

    private int $sequence = 0;

    // ---- scripting ---------------------------------------------------------------------------------------------------------

    /**
     * What the next call(s) of `$method` answer with: a value, a `Throwable` (thrown), or a `Closure` (called with the arguments).
     *
     * @param  int|null  $times  How many calls it serves; null = every call from now on.
     */
    public function will(string $method, mixed $response, ?int $times = 1): self
    {
        $this->scripts[$method][] = ['response' => $response, 'times' => $times];

        return $this;
    }

    public function willThrow(string $method, Throwable $exception, ?int $times = 1): self
    {
        return $this->will($method, $exception, $times);
    }

    /** A session the gateway already knows (for `getSession`, `startSession`, ... of an id that a factory made without calling the client). */
    public function withSession(OpenWaSession $session): self
    {
        $this->sessions[$session->id] = $session;
        $this->names[$session->name] = true;

        return $this;
    }

    /**
     * @param  array<string, mixed>  $overrides  Constructor arguments of OpenWaSession to override
     */
    public function makeSession(string $id, SessionStatus $status = SessionStatus::Created, string $name = 'fake-session', array $overrides = []): OpenWaSession
    {
        $raw = match ($status) {
            SessionStatus::Created => 'created',
            SessionStatus::Starting => 'initializing',
            SessionStatus::Qr => 'qr_ready',
            SessionStatus::Ready => 'ready',
            SessionStatus::Disconnected => 'disconnected',
            SessionStatus::Failed => 'failed',
        };

        return new OpenWaSession(...($overrides + [
            'id' => $id,
            'name' => $name,
            'status' => $status,
            'rawStatus' => $raw,
            'phone' => $status === SessionStatus::Ready ? '+4915100000000' : null,
            'pushName' => null,
            'connectedAt' => null,
            'lastError' => null,
            'engineLoaded' => $status->isRunning(),
        ]));
    }

    // ---- recording and assertions ------------------------------------------------------------------------------------------

    /**
     * @return list<array{method: string, args: array<string, mixed>}>
     */
    public function calls(?string $method = null): array
    {
        return $method === null ? $this->calls : array_values(array_filter($this->calls, static fn (array $call): bool => $call['method'] === $method));
    }

    /**
     * @param  (Closure(array<string, mixed>): bool)|null  $with  A predicate over the named arguments of a call
     */
    public function assertCalled(string $method, ?Closure $with = null, ?int $times = null): void
    {
        $matching = array_values(array_filter($this->calls($method), static fn (array $call): bool => $with === null || $with($call['args'])));

        Assert::assertNotEmpty($matching, "OpenWA {$method}() was not called".($with === null ? '' : ' with matching arguments').'.');

        if ($times !== null) {
            Assert::assertCount($times, $matching, "OpenWA {$method}() was called ".count($matching)." time(s), expected {$times}.");
        }
    }

    public function assertNotCalled(string $method): void
    {
        Assert::assertSame([], $this->calls($method), "OpenWA {$method}() was called.");
    }

    public function assertNothingCalled(): void
    {
        Assert::assertSame([], $this->calls, 'OpenWA was called: '.implode(', ', array_column($this->calls, 'method')));
    }

    // ---- OpenWaClient ------------------------------------------------------------------------------------------------------

    public function ping(): OpenWaPing
    {
        return $this->respond('ping', [], fn (): OpenWaPing => new OpenWaPing('operator', 'whatsapp-web.js'));
    }

    public function createSession(string $name): OpenWaSession
    {
        return $this->respond('createSession', ['name' => $name], function () use ($name): OpenWaSession {
            if (preg_match('/^[A-Za-z0-9-]{3,50}$/', $name) !== 1) {
                throw new OpenWaRejected('bad_request', 400, 'name must be 3-50 characters: letters, numbers and hyphens');
            }

            if (isset($this->names[$name])) {
                throw new OpenWaRejected('conflict', 409, "Session with name '{$name}' already exists");
            }

            $session = $this->makeSession($this->nextUuid(), SessionStatus::Created, $name);
            $this->sessions[$session->id] = $session;
            $this->names[$name] = true;

            return $session;
        });
    }

    public function startSession(string $sessionId): OpenWaSession
    {
        return $this->respond('startSession', ['sessionId' => $sessionId], fn (): OpenWaSession => $this->moveTo($sessionId, SessionStatus::Starting));
    }

    public function stopSession(string $sessionId): OpenWaSession
    {
        return $this->respond('stopSession', ['sessionId' => $sessionId], fn (): OpenWaSession => $this->moveTo($sessionId, SessionStatus::Disconnected));
    }

    public function deleteSession(string $sessionId): void
    {
        $this->respond('deleteSession', ['sessionId' => $sessionId], function () use ($sessionId): null {
            $session = $this->known($sessionId);
            unset($this->sessions[$sessionId], $this->names[$session->name]);

            return null;
        });
    }

    public function getSession(string $sessionId): OpenWaSession
    {
        return $this->respond('getSession', ['sessionId' => $sessionId], fn (): OpenWaSession => $this->known($sessionId));
    }

    public function getQr(string $sessionId): OpenWaQr
    {
        return $this->respond('getQr', ['sessionId' => $sessionId], function () use ($sessionId): OpenWaQr {
            $session = $this->known($sessionId);

            if ($session->status !== SessionStatus::Qr) {
                throw new OpenWaRejected('bad_request', 400, 'Session is not waiting for a QR scan');
            }

            return new OpenWaQr(WhatsAppSessionFactory::FAKE_QR, SessionStatus::Qr);
        });
    }

    public function registerWebhook(string $sessionId, string $url, string $secret, array $events): OpenWaWebhook
    {
        return $this->respond('registerWebhook', ['sessionId' => $sessionId, 'url' => $url, 'secret' => $secret, 'events' => $events], function () use ($url, $secret, $events): OpenWaWebhook {
            if (strlen($secret) < 16) {
                throw new OpenWaRejected('bad_request', 400, 'secret must be longer than or equal to 16 characters');
            }

            return new OpenWaWebhook($this->nextUuid(), $url, $events, true, 3);
        });
    }

    public function deleteWebhook(string $sessionId, string $webhookId): void
    {
        $this->respond('deleteWebhook', ['sessionId' => $sessionId, 'webhookId' => $webhookId], static fn (): null => null);
    }

    public function sendText(string $sessionId, string $chatId, string $text): OpenWaSendResult
    {
        return $this->respond('sendText', ['sessionId' => $sessionId, 'chatId' => $chatId, 'text' => $text], function () use ($chatId, $text): OpenWaSendResult {
            if ($text === '' || mb_strlen($text) > 4096) {
                throw new OpenWaRejected('bad_request', 400, 'text must be between 1 and 4096 characters');
            }

            return new OpenWaSendResult('true_'.$chatId.'_FAKE'.str_pad((string) ++$this->sequence, 6, '0', STR_PAD_LEFT), CarbonImmutable::now());
        });
    }

    public function downloadMedia(string $sessionId, string $chatId, string $messageId): ?OpenWaMedia
    {
        return $this->respond('downloadMedia', ['sessionId' => $sessionId, 'chatId' => $chatId, 'messageId' => $messageId], static fn (): null => null);
    }

    // ---- internals ---------------------------------------------------------------------------------------------------------

    /**
     * @param  array<string, mixed>  $args
     * @param  Closure(): mixed  $default
     */
    private function respond(string $method, array $args, Closure $default): mixed
    {
        $this->calls[] = ['method' => $method, 'args' => $args];

        $script = $this->scripts[$method][0] ?? null;

        if ($script === null) {
            return $default();
        }

        if ($script['times'] !== null && --$this->scripts[$method][0]['times'] <= 0) {
            array_shift($this->scripts[$method]);
        }

        $response = $script['response'];

        if ($response instanceof Throwable) {
            throw $response;
        }

        return $response instanceof Closure ? $response(...array_values($args)) : $response;
    }

    private function known(string $sessionId): OpenWaSession
    {
        return $this->sessions[$sessionId] ?? throw new OpenWaRejected('not_found', 404, "Session '{$sessionId}' not found");
    }

    private function moveTo(string $sessionId, SessionStatus $status): OpenWaSession
    {
        $current = $this->known($sessionId);
        $moved = $this->makeSession($sessionId, $status, $current->name);
        $this->sessions[$sessionId] = $moved;

        return $moved;
    }

    private function nextUuid(): string
    {
        return sprintf('00000000-0000-4000-8000-%012d', ++$this->sequence);
    }
}
