<?php

namespace Tests\Support;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Models\User;
use Tests\TestCase;

/**
 * Helpers of the WhatsApp tests: the fake OpenWA of this test, and the people the admin-only rule is tested with.
 *
 * @mixin TestCase
 */
trait WhatsAppFixtures
{
    /** The in-memory OpenWA bound by `Tests\TestCase`. */
    protected function openWa(): FakeOpenWaClient
    {
        $client = $this->app->make(OpenWaClient::class);

        if (! $client instanceof FakeOpenWaClient) {
            $client = new FakeOpenWaClient;
            $this->app->instance(OpenWaClient::class, $client);
        }

        return $client;
    }

    /**
     * Everybody the admin-only rule must tell apart: who may use WhatsApp, and who must be turned away.
     *
     * @return array{admin: User, adminAndAgent: User, agent: User, inactiveAdmin: User, inactiveAgent: User, noRole: User}
     */
    protected function whatsAppPeople(): array
    {
        return [
            'admin' => User::factory()->admin()->create(['is_agent' => false]),
            'adminAndAgent' => User::factory()->admin()->create(),
            'agent' => User::factory()->agent()->create(),
            'inactiveAdmin' => User::factory()->admin()->inactive()->create(),
            'inactiveAgent' => User::factory()->agent()->inactive()->create(),
            'noRole' => User::factory()->withoutChatAccess()->create(),
        ];
    }
}
