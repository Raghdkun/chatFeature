<?php

namespace App\Http\Middleware\WhatsApp;

use App\Domain\WhatsApp\Services\WebhookSignature;
use App\Http\Exceptions\ApiProblemException;
use App\Models\WhatsAppSession;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Gate of `POST /webhooks/openwa/{session}`: nothing is read, stored or queued before the request proves it comes from OpenWA.
 *
 *  - an unknown or deleted session is `404`;
 *  - a body over `whatsapp.webhook.max_body_bytes` is `413`: refused before the signature work (the size check needs no secret and
 *    bounds what the HMAC has to chew);
 *  - `X-OpenWA-Signature` must be `sha256=` and the HMAC-SHA256 of the RAW body with THIS session's webhook secret, compared in constant
 *    time (`WebhookSignature`); a missing, malformed or wrong signature, another session's secret, a body that was touched, all get the
 *    same `401 unauthenticated` with no hint, and nothing is stored.
 *
 * The verified session is exposed as the `openwa_session` request attribute. The body, the secret and the header are never logged.
 */
final class VerifyOpenWaSignature
{
    public function __construct(private readonly WebhookSignature $signature) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $session = $this->session($request->route('session'));

        if ($session === null) {
            throw ApiProblemException::notFound('not_found', __('Not found.'));
        }

        $max = max(1024, (int) config('whatsapp.webhook.max_body_bytes', 1048576));
        $declared = $request->headers->get('Content-Length');

        if (is_numeric($declared) && (int) $declared > $max) {
            return $this->tooLarge();
        }

        $body = $request->getContent();

        if (strlen($body) > $max) {
            return $this->tooLarge();
        }

        if (! $this->signature->valid($body, $request->headers->get(WebhookSignature::HEADER), $session->webhook_secret)) {
            throw ApiProblemException::unauthorized('unauthenticated', __('Authentication is required.'));
        }

        $request->attributes->set('openwa_session', $session);

        return $next($request);
    }

    private function session(mixed $parameter): ?WhatsAppSession
    {
        if ($parameter instanceof WhatsAppSession) {
            return $parameter->trashed() ? null : $parameter;
        }

        return is_string($parameter) ? WhatsAppSession::query()->where('ulid', strtolower($parameter))->first() : null;
    }

    private function tooLarge(): Response
    {
        return response()->json(['error' => ['code' => 'payload_too_large', 'message' => __('The request body is too large.')]], 413);
    }
}
