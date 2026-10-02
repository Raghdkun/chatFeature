<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Domain\WhatsApp\Jobs\RunWhatsAppSessionStart;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Throwable;

/**
 * An administrator connects a number (`POST /whatsapp/sessions/{ulid}/start`). The fast, failure-prone preparation runs in the request so
 * a misconfiguration is an immediate, readable answer; the slow part (OpenWA blocks until the engine is up, up to half a minute) is a job.
 *
 *  1. The session must exist at OpenWA (created now when it is not there yet, or was lost: OpenWA restarted without its data).
 *  2. The webhook is registered ONCE (`openwa_webhook_id`): a random 40-character secret, stored encrypted and never returned, the app's
 *     own address (`WhatsAppSession::webhookUrl()`) and the nine events the application handles. The secret is saved BEFORE OpenWA is told,
 *     so a lost answer cannot leave OpenWA signing with something we do not know. OpenWA refuses a private callback address unless
 *     its `SSRF_ALLOWED_HOSTS` allows the app's host: that is a `422 webhook_rejected` with the hint.
 *  3. The status moves to `starting` with a guarded `UPDATE ... WHERE status IN (created, disconnected, failed)` (two clicks start it once),
 *     then {@see RunWhatsAppSessionStart} asks OpenWA to start the engine. The QR and `ready` arrive by webhook.
 */
final class StartWhatsAppSession
{
    private const WEBHOOK_SECRET_LENGTH = 40;

    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly CreateWhatsAppSession $creator,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(WhatsAppSession $session, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);

        if (! $session->status->canStart()) {
            throw new ApiProblemException(409, 'session_not_startable', __('This session is already running.'), ['status' => $session->status->value]);
        }

        $session = $this->ensureRemote($session);
        $session = $this->ensureWebhook($session);

        $from = $session->status;
        $moved = WhatsAppSession::query()
            ->whereKey($session->id)
            ->whereIn('status', array_map(static fn (SessionStatus $status): string => $status->value, [SessionStatus::Created, SessionStatus::Disconnected, SessionStatus::Failed]))
            ->update(['status' => SessionStatus::Starting->value, 'last_error' => null, 'last_qr' => null, 'last_qr_at' => null, 'updated_at' => now()]);

        if ($moved !== 1) {
            throw new ApiProblemException(409, 'session_not_startable', __('This session is already running.'), ['status' => $session->refresh()->status->value]);
        }

        $session->refresh();
        $this->audit->record('whatsapp.session.started', $session, ['from' => $from->value], $actor);
        WaSessionStatusChanged::dispatch($session, $from);
        RunWhatsAppSessionStart::dispatch($session->id);

        return $session->refresh();
    }

    /**
     * @throws ApiProblemException
     */
    private function ensureRemote(WhatsAppSession $session): WhatsAppSession
    {
        if ($session->openwa_session_id !== null) {
            try {
                $this->openWa->getSession($session->openwa_session_id);

                return $session;
            } catch (OpenWaRejected $rejected) {
                if (! $rejected->isNotFound()) {
                    throw OpenWaProblem::from($rejected);
                }
            } catch (OpenWaUnavailable $unavailable) {
                throw OpenWaProblem::from($unavailable);
            }
        }

        // Not there (never created, or OpenWA lost it): create it again; a session that is new at OpenWA has no webhook.
        $remote = $this->creator->createRemote($session->name);

        $session->forceFill([
            'openwa_session_id' => $remote->id,
            'openwa_webhook_id' => null,
            'webhook_registered_at' => null,
        ])->save();

        return $session;
    }

    /**
     * The webhook is registered once. A webhook whose secret can no longer be read (the application key changed since) counts as not
     * registered: it would answer every delivery with a 401 for ever, so a fresh one is registered (the stale one is removed best effort).
     *
     * @throws ApiProblemException
     */
    private function ensureWebhook(WhatsAppSession $session): WhatsAppSession
    {
        if ($session->isWebhookRegistered() && $session->openwa_webhook_id !== null && $session->webhook_secret !== null) {
            return $session;
        }

        return $this->registerWebhook($session, replace: true);
    }

    /**
     * Register a webhook with a NEW secret (the first one, or a replacement for one that does not verify): the old secret and the old
     * webhook at OpenWA are dropped, and the session counts as "not registered" until OpenWA has accepted the new one (a refused
     * registration leaves Start free to try again). Called by Start when there is none and by `POST /whatsapp/sessions/{ulid}/webhook`.
     *
     * @throws ApiProblemException
     */
    public function registerWebhook(WhatsAppSession $session, bool $replace = false): WhatsAppSession
    {
        $session->webhook_secret = Str::random(self::WEBHOOK_SECRET_LENGTH);
        // From here on the stored registration is NOT trusted: the secret is new, so the old webhook (if it still exists) can no longer be
        // verified, and the old one is being deleted. A registration that is refused below must therefore leave the session "not
        // registered", so that the next Start registers again (otherwise Start would skip it for good, pointing at a deleted webhook).
        $session->webhook_registered_at = null;

        if ($replace && $session->openwa_webhook_id !== null && $session->openwa_session_id !== null) {
            try {
                $this->openWa->deleteWebhook($session->openwa_session_id, $session->openwa_webhook_id);
                $session->openwa_webhook_id = null;
            } catch (OpenWaRejected $rejected) {
                // Already gone: nothing left to point at. Any other refusal keeps the id, so the next attempt tries to delete it again.
                if ($rejected->isNotFound()) {
                    $session->openwa_webhook_id = null;
                }
            } catch (Throwable) {
                // OpenWA cannot be asked: the id stays for the next attempt; the registration below says what is wrong.
            }
        }

        $session->save();

        try {
            $webhook = $this->openWa->registerWebhook(
                (string) $session->openwa_session_id,
                $session->webhookUrl(),
                (string) $session->webhook_secret,
                array_values(array_filter((array) config('whatsapp.webhook_events', []), is_string(...))),
            );
        } catch (OpenWaRejected $rejected) {
            throw $rejected->status === 400 ? $this->webhookRefusal($session, $rejected) : OpenWaProblem::from($rejected);
        } catch (Throwable $exception) {
            throw OpenWaProblem::from($exception);
        }

        $session->forceFill(['openwa_webhook_id' => $webhook->id, 'webhook_registered_at' => now()])->save();

        return $session;
    }

    /**
     * OpenWA refused the registration with a 400. In production its validation errors are a bare "Bad Request" (field detail is off), so the
     * cause is recognised by the MESSAGE when there is one: its SSRF guard says "Destination address is not allowed"; the per-session limit
     * says "Webhook limit reached ... (16/16)". A bare 400 is treated as the (by far) most likely cause, the address, and says what else it
     * could be.
     */
    private function webhookRefusal(WhatsAppSession $session, OpenWaRejected $rejected): ApiProblemException
    {
        $message = $rejected->getMessage();

        if (stripos($message, 'limit reached') !== false) {
            return new ApiProblemException(
                409,
                'webhook_limit_reached',
                __('OpenWA already holds the maximum number of webhooks for this session (:reason). Delete the old ones in OpenWA (or delete the session there), then start again.', ['reason' => mb_substr($message, 0, 160)]),
                ['reason' => mb_substr($message, 0, 160)],
            );
        }

        $host = (string) parse_url($session->webhookUrl(), PHP_URL_HOST);
        $guard = stripos($message, 'Destination address is not allowed') !== false;
        // (`OpenWaRejected` supplies "OpenWA refused the request (<code>)." when the body had no message at all.)
        $bare = $message === '' || strcasecmp(trim($message), 'Bad Request') === 0 || str_starts_with($message, 'OpenWA refused the request (');

        $cause = $guard || $bare
            ? __('OpenWA only calls addresses that resolve to public IPs and never follows a redirect: when this app is on a private network (or in development) add its exact host name (:host) to OpenWA\'s SSRF_ALLOWED_HOSTS and restart OpenWA; use the final https address as the application URL (a http address that is redirected to https counts as a failed delivery); in development with OpenWA in Docker the application URL must be http://host.docker.internal:<port> or a tunnel, never 127.0.0.1.', ['host' => $host])
            : __('OpenWA said: :reason', ['reason' => mb_substr($message, 0, 200)]);

        return new ApiProblemException(
            422,
            'webhook_rejected',
            __('OpenWA refused the webhook address :url. :cause', ['url' => $session->webhookUrl(), 'cause' => $cause]),
            ['host' => $host, 'url' => $session->webhookUrl()],
        );
    }
}
