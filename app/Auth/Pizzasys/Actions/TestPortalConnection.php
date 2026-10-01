<?php

namespace App\Auth\Pizzasys\Actions;

use App\Auth\Pizzasys\NatsProbe;
use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalProbeResult;
use App\Data\Auth\PortalCheckData;
use App\Data\Auth\PortalCheckKey;
use App\Data\Auth\PortalTestResultData;
use Spatie\LaravelData\Optional;

/**
 * Connection test shared by the wizard, Settings > Auth and `chat:auth:test`: is the portal reachable, does it accept
 * our service credential (a `token-verify` probe with a made-up token must answer HTTP 200 `active:false`), how fast
 * is it and, when configured, is NATS reachable. Talks to the portal directly (no cache, no circuit breaker).
 */
final class TestPortalConnection
{
    /** Above this a verify is considered slow (the login path adds a verify to every sign-in). */
    public const SLOW_MILLISECONDS = 1500;

    public function __construct(
        private readonly PizzasysClient $client,
        private readonly NatsProbe $nats,
    ) {}

    public function __invoke(PizzasysEndpoint $endpoint, ?string $natsUrl = null, ?string $natsToken = null): PortalTestResultData
    {
        $probe = $this->client->probe($endpoint);

        $latencyOk = $probe->reachable && $probe->latencyMs !== null && $probe->latencyMs <= self::SLOW_MILLISECONDS;

        $checks = [
            new PortalCheckData(PortalCheckKey::Reachable, __('Portal reachable'), $probe->reachable, $this->reachableMessage($probe)),
            new PortalCheckData(PortalCheckKey::ServiceCredential, __('Service credential accepted'), $probe->serviceCredentialAccepted, $this->credentialMessage($probe)),
            new PortalCheckData(
                PortalCheckKey::Latency,
                __('Response time'),
                $latencyOk,
                $probe->latencyMs !== null ? __(':ms ms', ['ms' => $probe->latencyMs]).($latencyOk ? '' : ' - '.__('slow')) : __('Not measured.'),
            ),
            $this->natsCheck($natsUrl, $natsToken, $endpoint->verifyTls),
        ];

        return new PortalTestResultData($probe->reachable && $probe->serviceCredentialAccepted, $checks);
    }

    private function reachableMessage(PortalProbeResult $probe): string|Optional
    {
        if ($probe->reachable) {
            return new Optional;
        }

        return $probe->message ?? PortalFailure::message(null);
    }

    private function credentialMessage(PortalProbeResult $probe): string|Optional
    {
        if ($probe->serviceCredentialAccepted) {
            return new Optional;
        }

        if (! $probe->reachable) {
            return __('Skipped: the portal is not reachable.');
        }

        return $probe->message ?? __('The portal did not accept the service credential.');
    }

    private function natsCheck(?string $url, ?string $token, bool $verifyTls): PortalCheckData
    {
        if ($url === null || $url === '') {
            return new PortalCheckData(PortalCheckKey::Nats, __('NATS events'), true, __('Not configured (optional).'));
        }

        $result = $this->nats->probe($url, $token, $verifyTls);

        return new PortalCheckData(PortalCheckKey::Nats, __('NATS events'), $result['ok'], $result['message']);
    }
}
