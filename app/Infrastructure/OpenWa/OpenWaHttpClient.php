<?php

namespace App\Infrastructure\OpenWa;

use App\Domain\Settings\SettingsRepository;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaAddressRefused;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaNotConfigured;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRequestNotConfirmed;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaWebhook;
use App\Rules\OpenWaBaseUrl;
use App\Support\Network\OutboundUrlGuard;
use GuzzleHttp\Exception\ConnectException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Validator;
use Psr\Http\Message\StreamInterface;
use Throwable;

/**
 * The HTTP side of the self-hosted OpenWA gateway (`docs/reference/openwa-api.md`): every method of the spine's {@see OpenWaClient}
 * over Laravel's `Http`. Stateless: the base URL and the API key are read from the `whatsapp.openwa.*` settings for every call, so a
 * change in Settings > WhatsApp takes effect at once.
 *
 *  - The key goes in the `X-API-Key` header only (never in a URL), is never logged and never put into an exception message; transport
 *    failures are reduced to a fixed sentence (the URL of the failed call is dropped too).
 *  - The saved address is judged by the outbound guard right before the call (the rule of the settings form, then the resolved
 *    addresses) and, with the curl handler, the connection goes to the address that was just judged (`CURLOPT_RESOLVE`): a name
 *    that was re-pointed at the internal network after it was saved cannot steer the key there. Redirects are never followed.
 *  - Writes are never repeated blindly. A GET is repeated once when the connection itself failed. A write that was sent but never
 *    answered is an {@see OpenWaRequestNotConfirmed} (it may have been carried out), a write that never connected a plain
 *    {@see OpenWaUnavailable}. A SEND is stricter still: a `5xx` (a proxy's 502 / 504 included) or a `2xx` whose body has no usable
 *    message id are {@see OpenWaRequestNotConfirmed} as well.
 *  - Answers are validated, not trusted: 2xx bodies must be what the API documents (a QR is a base64 PNG data URL of a sane size,
 *    media is bounded by `whatsapp.media_max_bytes`), a 4xx becomes {@see OpenWaRejected} (`429 SEND_PACING_LIMITED` its
 *    {@see OpenWaPacingLimited}), anything else {@see OpenWaUnavailable}.
 *
 * Timeouts: `config/whatsapp.php` (`http.*`).
 */
final class OpenWaHttpClient implements OpenWaClient
{
    /** Chunk size when reading a media download. */
    private const READ_CHUNK = 65536;

    public function __construct(
        private readonly HttpFactory $http,
        private readonly SettingsRepository $settings,
        private readonly OutboundUrlGuard $guard,
    ) {}

    public function ping(): OpenWaPing
    {
        return OpenWaPing::fromArray($this->object($this->send('POST', '/api/auth/validate')));
    }

    public function createSession(string $name): OpenWaSession
    {
        return OpenWaSession::fromArray($this->object($this->send('POST', '/api/sessions', ['name' => $name])));
    }

    public function startSession(string $sessionId): OpenWaSession
    {
        return OpenWaSession::fromArray($this->object($this->send('POST', $this->session($sessionId).'/start', timeout: 'start_timeout')));
    }

    public function stopSession(string $sessionId): OpenWaSession
    {
        return OpenWaSession::fromArray($this->object($this->send('POST', $this->session($sessionId).'/stop', timeout: 'stop_timeout')));
    }

    public function deleteSession(string $sessionId): void
    {
        $this->send('DELETE', $this->session($sessionId), timeout: 'stop_timeout');
    }

    public function getSession(string $sessionId): OpenWaSession
    {
        return OpenWaSession::fromArray($this->object($this->send('GET', $this->session($sessionId))));
    }

    public function getQr(string $sessionId): OpenWaQr
    {
        return OpenWaQr::fromArray($this->object($this->send('GET', $this->session($sessionId).'/qr', timeout: 'qr_timeout')));
    }

    public function registerWebhook(string $sessionId, string $url, #[\SensitiveParameter] string $secret, array $events): OpenWaWebhook
    {
        return OpenWaWebhook::fromArray($this->object($this->send('POST', $this->session($sessionId).'/webhooks', [
            'url' => $url,
            'events' => $events,
            'secret' => $secret,
        ])));
    }

    public function deleteWebhook(string $sessionId, string $webhookId): void
    {
        $this->send('DELETE', $this->session($sessionId).'/webhooks/'.rawurlencode($webhookId));
    }

    public function sendText(string $sessionId, string $chatId, string $text): OpenWaSendResult
    {
        $response = $this->send('POST', $this->session($sessionId).'/messages/send-text', [
            'chatId' => $chatId,
            'text' => $text,
        ], timeout: 'send_timeout', mayHaveBeenCarriedOut: true);

        // A `2xx` whose body is not what the API documents: the message was probably sent, only the answer is unusable.
        try {
            return OpenWaSendResult::fromArray($this->object($response));
        } catch (OpenWaUnavailable) {
            throw new OpenWaRequestNotConfirmed('OpenWA answered the send, but not with a usable message id: it may have been carried out.');
        }
    }

    public function downloadMedia(string $sessionId, string $chatId, string $messageId): ?OpenWaMedia
    {
        $path = $this->session($sessionId).'/messages/'.rawurlencode($chatId).'/'.rawurlencode($messageId).'/media';

        try {
            $response = $this->send('GET', $path, timeout: 'media_timeout', stream: true);
        } catch (OpenWaRejected $rejected) {
            if ($rejected->isNotFound()) {
                return null;
            }

            throw $rejected;
        }

        $max = max(1, $this->settings->int('whatsapp.media_max_bytes', 5 * 1024 * 1024));
        $contents = $this->readLimited($response->toPsrResponse()->getBody(), $max);

        if ($contents === '') {
            return null;
        }

        return new OpenWaMedia(
            $contents,
            $this->mimeOf($response->header('Content-Type')),
            $this->filenameOf($response->header('Content-Disposition')),
        );
    }

    // ---- transport ---------------------------------------------------------------------------------------------------------

    /**
     * One call: the endpoint judged and pinned, the key in its header, the answer checked for a success status.
     *
     * @param  array<string, mixed>|null  $json
     * @param  string  $timeout  A key of `config('whatsapp.http')`
     * @param  bool  $mayHaveBeenCarriedOut  The call is a write that must never be repeated blindly (a message to a customer): a `5xx` is
     *                                       then {@see OpenWaRequestNotConfirmed} (a proxy's 502 / 504 says nothing about whether the
     *                                       gateway behind it already did the work), not a plain, retryable {@see OpenWaUnavailable}
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    private function send(string $method, string $path, ?array $json = null, string $timeout = 'timeout', bool $stream = false, bool $mayHaveBeenCarriedOut = false): Response
    {
        $endpoint = $this->endpoint();
        $request = $this->pending($endpoint, $this->seconds($timeout), retry: $method === 'GET', stream: $stream);
        $url = $endpoint->url($path);

        try {
            $response = match (true) {
                $json !== null => $request->send($method, $url, ['json' => $json]),
                default => $request->send($method, $url),
            };
        } catch (ConnectionException $exception) {
            throw $this->transportFailure($exception, write: $method !== 'GET');
        }

        return $this->checked($response, $mayHaveBeenCarriedOut);
    }

    private function pending(OpenWaEndpoint $endpoint, int $timeout, bool $retry, bool $stream): PendingRequest
    {
        $request = $this->http->acceptJson()
            ->withHeaders(['X-API-Key' => $endpoint->apiKey()])
            ->connectTimeout(max(1, (int) config('whatsapp.http.connect_timeout', 3)))
            ->timeout($timeout)
            ->withoutRedirecting();

        // Connect to the address that was just judged instead of resolving the name a second time.
        if (($entry = $endpoint->target->curlResolveEntry()) !== null && defined('CURLOPT_RESOLVE')) {
            $request = $request->withOptions(['curl' => [CURLOPT_RESOLVE => [$entry]]]);
        }

        if ($stream) {
            $request = $request->withOptions(['stream' => true]);
        }

        // One more try, and only when the connection itself failed (an HTTP answer, a 5xx included, is never repeated).
        return $retry
            ? $request->retry(2, 150, fn (?Throwable $exception): bool => $exception instanceof ConnectionException, throw: false)
            : $request;
    }

    /**
     * The saved address and key, the address checked right now.
     *
     * @throws OpenWaNotConfigured|OpenWaAddressRefused
     */
    private function endpoint(): OpenWaEndpoint
    {
        $key = $this->settings->string('whatsapp.openwa.api_key', '');

        if ($key === '') {
            throw new OpenWaNotConfigured('OpenWA is not configured: no API key is saved.');
        }

        $baseUrl = $this->settings->string('whatsapp.openwa.base_url', 'http://127.0.0.1:2785');
        $refused = new OpenWaAddressRefused('The configured OpenWA address is not allowed.');

        // The rule of the settings form says what a base URL may look like; the guard judges where it points now.
        $accepted = Validator::make(['base_url' => $baseUrl], ['base_url' => [new OpenWaBaseUrl]])->passes();
        $parts = $accepted ? parse_url($baseUrl) : false;

        if ($parts === false || ! isset($parts['scheme'], $parts['host'])) {
            throw $refused;
        }

        $scheme = strtolower($parts['scheme']);
        $target = $this->guard->checkHost($parts['host'], $parts['port'] ?? ($scheme === 'http' ? 80 : 443), $scheme);

        if (! $target->ok) {
            throw $refused;
        }

        return new OpenWaEndpoint($baseUrl, $key, $target);
    }

    private function seconds(string $key): int
    {
        return max(1, (int) config('whatsapp.http.'.$key, 15));
    }

    /**
     * What a failed connection means for the caller. The message is a fixed sentence: the failed URL and the exception text are
     * dropped on purpose.
     */
    private function transportFailure(ConnectionException $exception, bool $write): OpenWaUnavailable
    {
        if ($write && ! $this->neverReachedOpenWa($exception)) {
            return new OpenWaRequestNotConfirmed('OpenWA did not answer after the request was sent: it may or may not have been carried out.');
        }

        return new OpenWaUnavailable('OpenWA could not be reached.');
    }

    /**
     * Whether the request certainly never left: the name did not resolve, the connection was refused, or the connect phase itself
     * timed out. Anything else (including "no detail at all") is treated as "may have been sent".
     */
    private function neverReachedOpenWa(ConnectionException $exception): bool
    {
        $previous = $exception->getPrevious();

        if (! $previous instanceof ConnectException) {
            return false;
        }

        $context = $previous->getHandlerContext();
        $errno = $context['errno'] ?? null;

        if (in_array($errno, [6, 7], true)) {
            return true;
        }

        return $errno === 28 && (float) ($context['connect_time'] ?? 1) <= 0.0;
    }

    /**
     * Success statuses pass; the rest becomes the documented exceptions.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    private function checked(Response $response, bool $mayHaveBeenCarriedOut = false): Response
    {
        $status = $response->status();

        if ($status >= 200 && $status < 300) {
            return $response;
        }

        if ($status >= 400 && $status < 500) {
            $retryAfter = $response->header('Retry-After');

            throw OpenWaRejected::fromResponse($status, $this->errorBody($response), is_numeric($retryAfter) ? (int) $retryAfter : null);
        }

        if ($mayHaveBeenCarriedOut) {
            throw new OpenWaRequestNotConfirmed('OpenWA answered HTTP '.$status.' to a write: it may or may not have been carried out.');
        }

        throw new OpenWaUnavailable('OpenWA answered HTTP '.$status.'.');
    }

    /**
     * @return array<array-key, mixed>
     */
    private function errorBody(Response $response): array
    {
        try {
            $decoded = $response->json();
        } catch (Throwable) {
            return [];
        }

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * The JSON object of a success answer.
     *
     * @return array<array-key, mixed>
     *
     * @throws OpenWaUnavailable when the body is not a JSON object
     */
    private function object(Response $response): array
    {
        $decoded = $response->json();

        if (! is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
            throw new OpenWaUnavailable('OpenWA answered with something other than the documented JSON object.');
        }

        return $decoded;
    }

    private function session(string $sessionId): string
    {
        return '/api/sessions/'.rawurlencode($sessionId);
    }

    /**
     * @throws OpenWaRejected when the body is bigger than `$max` (`413`)
     */
    private function readLimited(StreamInterface $body, int $max): string
    {
        $contents = '';

        while (! $body->eof()) {
            $contents .= $body->read(self::READ_CHUNK);

            if (strlen($contents) > $max) {
                throw new OpenWaRejected('payload_too_large', 413, 'The media is larger than the configured limit.');
            }
        }

        return $contents;
    }

    private function mimeOf(string $contentType): string
    {
        $mime = strtolower(trim(explode(';', $contentType)[0]));

        return $mime === '' ? 'application/octet-stream' : $mime;
    }

    private function filenameOf(string $disposition): ?string
    {
        if (preg_match('/filename\*?=(?:UTF-8\'\')?"?([^";]+)"?/i', $disposition, $matches) !== 1) {
            return null;
        }

        $name = trim(basename(str_replace('\\', '/', rawurldecode($matches[1]))));

        return $name === '' ? null : mb_substr($name, 0, 255);
    }
}
