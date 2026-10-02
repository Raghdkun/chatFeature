<?php

namespace App\Domain\WhatsApp\Support;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaPing;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSendResult;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaWebhook;

/**
 * The default `OpenWaClient` until the HTTP implementation (6A) is bound: every call throws {@see OpenWaUnavailable}, so a code path
 * that reaches OpenWA without a configured client fails loudly instead of touching a network.
 */
final class NullOpenWaClient implements OpenWaClient
{
    public function ping(): OpenWaPing
    {
        throw $this->unavailable();
    }

    public function createSession(string $name): OpenWaSession
    {
        throw $this->unavailable();
    }

    public function startSession(string $sessionId): OpenWaSession
    {
        throw $this->unavailable();
    }

    public function stopSession(string $sessionId): OpenWaSession
    {
        throw $this->unavailable();
    }

    public function deleteSession(string $sessionId): void
    {
        throw $this->unavailable();
    }

    public function getSession(string $sessionId): OpenWaSession
    {
        throw $this->unavailable();
    }

    public function getQr(string $sessionId): OpenWaQr
    {
        throw $this->unavailable();
    }

    public function registerWebhook(string $sessionId, string $url, string $secret, array $events): OpenWaWebhook
    {
        throw $this->unavailable();
    }

    public function deleteWebhook(string $sessionId, string $webhookId): void
    {
        throw $this->unavailable();
    }

    public function sendText(string $sessionId, string $chatId, string $text): OpenWaSendResult
    {
        throw $this->unavailable();
    }

    public function downloadMedia(string $sessionId, string $chatId, string $messageId): ?OpenWaMedia
    {
        throw $this->unavailable();
    }

    private function unavailable(): OpenWaUnavailable
    {
        return new OpenWaUnavailable('No OpenWA client is configured.');
    }
}
