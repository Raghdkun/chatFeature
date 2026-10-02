<?php

namespace App\Domain\WhatsApp\Contracts;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaPacingLimited;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaWebhook;

/**
 * The calls the application makes to the self-hosted OpenWA gateway (`docs/reference/openwa-api.md`, `docs/whatsapp-openwa.md`). The
 * HTTP implementation (6A, `app/Infrastructure/OpenWa`) takes the base URL and API key from the `whatsapp.openwa.*` settings; the default
 * binding is `NullOpenWaClient` (every call throws {@see OpenWaUnavailable}) so nothing reaches a network by accident, and tests get
 * `Tests\Support\FakeOpenWaClient`.
 *
 * OpenWA answers without an envelope. Every method turns a failure into one of three exceptions: {@see OpenWaUnavailable} (network
 * error, timeout, 5xx, or an answer that is not what the API documents: retry later), {@see OpenWaRejected} (a 4xx: the request was
 * refused, `errorCode` / `status` say why) and {@see OpenWaPacingLimited} (a `429 SEND_PACING_LIMITED`, which extends
 * {@see OpenWaRejected}: do not retry before `retryAfterSeconds`).
 *
 * `$sessionId` is always the id OpenWA assigned (`whatsapp_sessions.openwa_session_id`), never our ulid.
 */
interface OpenWaClient
{
    /**
     * Whether OpenWA is reachable and the configured API key is accepted (`POST /api/auth/validate`): the connection test.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function ping(): OpenWaPing;

    /**
     * `POST /api/sessions {name}`: a new session in status `created` (the name: 3-50 letters, digits or hyphens; a duplicate is a `409`).
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function createSession(string $name): OpenWaSession;

    /**
     * `POST /api/sessions/{id}/start`: the engine starts (`initializing`, then `qr_ready` or, for a paired session, `ready`).
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function startSession(string $sessionId): OpenWaSession;

    /**
     * `POST /api/sessions/{id}/stop`: the engine stops (`disconnected`); the session stays down until it is started again.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function stopSession(string $sessionId): OpenWaSession;

    /**
     * `DELETE /api/sessions/{id}`: removes the session, its messages and webhooks at OpenWA. A session that is already gone is a
     * `404` {@see OpenWaRejected}.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function deleteSession(string $sessionId): void;

    /**
     * `GET /api/sessions/{id}`: the session as OpenWA sees it now (reconciliation).
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function getSession(string $sessionId): OpenWaSession;

    /**
     * `GET /api/sessions/{id}/qr`: the pairing QR as a PNG data URL. OpenWA answers `400` while the session is not waiting for a scan
     * (not started, QR not rendered yet, already authenticated): that is an {@see OpenWaRejected}, not a failure.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function getQr(string $sessionId): OpenWaQr;

    /**
     * `POST /api/sessions/{id}/webhooks`: where OpenWA delivers `$events` (`message.received`, `message.ack`, `session.status`, ...),
     * signed with `$secret` (at least 16 characters; OpenWA never returns it). OpenWA refuses URLs that resolve to private addresses
     * unless `SSRF_ALLOWED_HOSTS` allows the host (`400`), and allows 16 webhooks per session.
     *
     * @param  list<string>  $events
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function registerWebhook(string $sessionId, string $url, string $secret, array $events): OpenWaWebhook;

    /**
     * `DELETE /api/sessions/{id}/webhooks/{webhookId}`.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function deleteWebhook(string $sessionId, string $webhookId): void;

    /**
     * `POST /api/sessions/{id}/messages/send-text`: `201` means accepted, not delivered (the result carries OpenWA's message id; delivery
     * arrives as `message.ack` webhooks). `$text` is at most 4096 characters.
     *
     * @throws OpenWaUnavailable|OpenWaRejected|OpenWaPacingLimited
     */
    public function sendText(string $sessionId, string $chatId, string $text): OpenWaSendResult;

    /**
     * `GET /api/sessions/{id}/messages/{chatId}/{messageId}/media`: the stored bytes of a message's media (what the webhook marks
     * `omitted` when it is large). Null when OpenWA holds none for the message (`404`). Note that OpenWA's route needs the chat id too.
     *
     * @throws OpenWaUnavailable|OpenWaRejected
     */
    public function downloadMedia(string $sessionId, string $chatId, string $messageId): ?OpenWaMedia;
}
