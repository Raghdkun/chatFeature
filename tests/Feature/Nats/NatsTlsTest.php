<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\NatsProbe;
use App\Infrastructure\Nats\BasisJetStreamGateway;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\NatsEndpoint;
use App\Infrastructure\Nats\NatsSettings;
use App\Infrastructure\Nats\TlsPolicy;
use App\Support\Network\HostResolver;
use App\Support\Network\OutboundTarget;
use Tests\Support\FakeHostResolver;
use Tests\Support\Nats\RunsNatsStub;
use Tests\Support\Nats\SelfSignedCertificate;
use Tests\TestCase;

/**
 * The TLS behaviour of the NATS session (consumer gateway and connection probe) against the protocol stub:
 * certificate and host name are verified, a `tls://` address (or a verified public `nats://` one) never falls back to
 * plaintext, and the token is not written before TLS is up. A throwaway self-signed certificate stands in for the
 * server's, valid for `nats.example.test` only.
 */
class NatsTlsTest extends TestCase
{
    use RunsNatsStub;

    private SelfSignedCertificate $certificate;

    protected function setUp(): void
    {
        parent::setUp();

        // The stub listens on 127.0.0.1: allowed here as on a private-network deployment, reached through names that the
        // fake resolver points there (the connection goes to the resolved address, whatever the name is).
        config(['chat.portal_allow_private_hosts' => true]);
        $this->app->instance(HostResolver::class, new FakeHostResolver([
            'nats.example.test' => ['127.0.0.1'],
            'other.example.test' => ['127.0.0.1'],
        ]));
        $this->certificate = SelfSignedCertificate::create('nats.example.test');
    }

    protected function tearDown(): void
    {
        $this->stopStub();
        $this->certificate->delete();

        parent::tearDown();
    }

    private function settings(string $url, bool $verifyTls = true, ?string $caFile = null, ?string $token = 'secret-nats-token'): NatsSettings
    {
        return new NatsSettings(enabled: true, url: $url, token: $token, tlsCaFile: $caFile, verifyTls: $verifyTls);
    }

    private function connectFailure(NatsSettings $settings): string
    {
        try {
            (new BasisJetStreamGateway)->connect($settings);
        } catch (GatewayException $exception) {
            return $exception->getMessage();
        }

        $this->fail('The connection should have been refused.');
    }

    // ---- the consumer's gateway -------------------------------------------------------------------------------------

    public function test_a_tls_address_never_runs_a_plaintext_session_and_the_token_is_not_sent(): void
    {
        $this->startStub(['token' => 'secret-nats-token']); // a server without TLS

        $message = $this->connectFailure($this->settings('tls://nats.example.test:'.$this->stubPort));

        $this->assertStringContainsString('does not offer TLS', $message);
        $this->assertFalse($this->stubSawConnect(), 'no CONNECT frame (and so no token) was written');
    }

    public function test_an_untrusted_certificate_fails_the_handshake_before_any_token_is_sent(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $message = $this->connectFailure($this->settings('tls://nats.example.test:'.$this->stubPort));

        $this->assertStringContainsString('TLS handshake failed', $message);
        $this->assertStringNotContainsString('nats.example.test', $message, 'OpenSSL text is not passed on');
        $this->assertContains('TLS_FAILED', $this->stubLines());
        $this->assertFalse($this->stubSawConnect());
    }

    public function test_a_trusted_certificate_for_the_right_host_connects_and_the_token_goes_over_tls(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);
        $gateway = new BasisJetStreamGateway;

        $gateway->connect($this->settings('tls://nats.example.test:'.$this->stubPort, caFile: $this->certificate->ca));

        $lines = $this->stubLines();
        $this->assertContains('TLS_OK', $lines);
        $this->assertContains('CONNECT headers=1 token=secret-nats-token', $lines);
        $gateway->disconnect();
    }

    public function test_the_host_name_is_checked_even_when_the_certificate_is_trusted(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $message = $this->connectFailure($this->settings('tls://other.example.test:'.$this->stubPort, caFile: $this->certificate->ca));

        $this->assertStringContainsString('TLS handshake failed', $message);
        $this->assertFalse($this->stubSawConnect());
    }

    public function test_an_ip_address_does_not_satisfy_a_certificate_for_a_name(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $this->assertStringContainsString('TLS handshake failed', $this->connectFailure($this->settings('tls://127.0.0.1:'.$this->stubPort, caFile: $this->certificate->ca)));
    }

    public function test_switching_verification_off_accepts_a_self_signed_certificate(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);
        $gateway = new BasisJetStreamGateway;

        $gateway->connect($this->settings('tls://nats.example.test:'.$this->stubPort, verifyTls: false));

        $this->assertContains('CONNECT headers=1 token=secret-nats-token', $this->stubLines());
        $gateway->disconnect();
    }

    public function test_a_plain_nats_address_on_a_private_network_may_stay_plaintext_with_verification_on(): void
    {
        $this->startStub(['token' => 'secret-nats-token']);
        $gateway = new BasisJetStreamGateway;

        $gateway->connect($this->settings('nats://nats.example.test:'.$this->stubPort));

        $this->assertContains('CONNECT headers=1 token=secret-nats-token', $this->stubLines());
        $gateway->disconnect();
    }

    public function test_a_server_that_does_offer_tls_on_a_nats_address_is_verified_too(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $message = $this->connectFailure($this->settings('nats://nats.example.test:'.$this->stubPort));

        $this->assertStringContainsString('TLS handshake failed', $message, 'the library alone would have accepted any certificate here');
        $this->assertFalse($this->stubSawConnect());
    }

    public function test_the_connection_goes_to_the_validated_address_not_to_a_second_lookup(): void
    {
        $this->startStub(['token' => 'secret-nats-token']);
        $resolver = $this->app->make(HostResolver::class);
        $this->assertInstanceOf(FakeHostResolver::class, $resolver);
        $gateway = new BasisJetStreamGateway;

        $gateway->connect($this->settings('nats://nats.example.test:'.$this->stubPort, verifyTls: false));

        $this->assertSame(['nats.example.test'], $resolver->lookups, 'one lookup, by the guard; the socket opened to its answer');
        $gateway->disconnect();
    }

    public function test_the_gateway_refuses_an_address_the_outbound_guard_refuses(): void
    {
        config(['chat.portal_allow_private_hosts' => false]);

        $this->assertStringContainsString('not allowed', $this->connectFailure($this->settings('nats://127.0.0.1:4222')));
        $this->assertStringContainsString('not allowed', $this->connectFailure($this->settings('nats://169.254.169.254:4222')));
    }

    // ---- the connection probe ---------------------------------------------------------------------------------------

    public function test_the_probe_verifies_the_certificate_and_reports_success_over_tls(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $result = (new NatsProbe)->probe('tls://nats.example.test:'.$this->stubPort, 'secret-nats-token', true, $this->certificate->ca);

        $this->assertTrue($result['ok']);
        $this->assertContains('TLS_OK', $this->stubLines());
    }

    public function test_the_probe_refuses_an_untrusted_certificate_and_never_sends_the_token(): void
    {
        $this->startStub(['token' => 'secret-nats-token', 'tls' => ['pem' => $this->certificate->pem]]);

        $result = (new NatsProbe)->probe('tls://nats.example.test:'.$this->stubPort, 'secret-nats-token', true);

        $this->assertFalse($result['ok']);
        $this->assertFalse($this->stubSawConnect());
    }

    public function test_the_probe_refuses_plaintext_for_a_tls_address(): void
    {
        $this->startStub(['token' => 'secret-nats-token']);

        $result = (new NatsProbe)->probe('tls://nats.example.test:'.$this->stubPort, 'secret-nats-token', true);

        $this->assertFalse($result['ok']);
        $this->assertFalse($this->stubSawConnect(), 'the token was not written in clear');
    }

    public function test_every_failure_of_the_probe_reads_the_same(): void
    {
        $messages = [];

        // a port nothing listens on
        $closed = stream_socket_server('tcp://127.0.0.1:0');
        $closedPort = (int) explode(':', (string) stream_socket_get_name($closed, false))[1];
        fclose($closed);
        $messages['closed port'] = (new NatsProbe)->probe('nats://nats.example.test:'.$closedPort, 'tok')['message'];

        // something that is not NATS
        $this->startStub(['banner' => 'HTTP/1.1 400 Bad Request']);
        $messages['not nats'] = (new NatsProbe)->probe('nats://nats.example.test:'.$this->stubPort, 'tok')['message'];
        $this->stopStub();

        // NATS, wrong token
        $this->startStub(['token' => 'right-token']);
        $messages['wrong token'] = (new NatsProbe)->probe('nats://nats.example.test:'.$this->stubPort, 'wrong-token')['message'];
        $this->stopStub();

        // an address the guard refuses, and one that is not an address
        config(['chat.portal_allow_private_hosts' => false]);
        $messages['refused address'] = (new NatsProbe)->probe('nats://127.0.0.1:4222', 'tok')['message'];
        $messages['malformed'] = (new NatsProbe)->probe('http://nope', 'tok')['message'];

        $this->assertCount(1, array_unique($messages), 'the messages differ: '.json_encode($messages));
        $this->assertStringNotContainsString('tok', implode(' ', array_map(fn (string $m): string => str_replace('token', '', $m), $messages)));
    }

    public function test_a_hostile_server_cannot_make_the_probe_read_without_limit(): void
    {
        $this->startStub(['garbage_info' => 400_000]);
        $started = microtime(true);

        $result = (new NatsProbe)->probe('nats://nats.example.test:'.$this->stubPort, null);

        $this->assertFalse($result['ok']);
        $this->assertLessThan(NatsProbe::TIMEOUT_SECONDS * 2 + 2, microtime(true) - $started);
    }

    public function test_the_probe_bounds_its_reads(): void
    {
        $listener = stream_socket_server('tcp://127.0.0.1:0');
        $client = stream_socket_client('tcp://'.stream_socket_get_name($listener, false));
        $server = stream_socket_accept($listener, 2);
        stream_set_blocking($server, false);

        $written = 0;
        for ($i = 0; $i < 20; $i++) {
            $chunk = (int) @fwrite($server, str_repeat('A', 65_536));
            $written += $chunk;

            if ($chunk === 0) {
                break;
            }
        }
        $this->assertGreaterThan(NatsProbe::MAX_LINE_BYTES * 2, $written, 'the test needs more pending bytes than the limit');

        $result = (new NatsProbe)->handshake($client, 'tok');

        $this->assertFalse($result['ok']);
        stream_set_blocking($client, false);
        $unread = strlen((string) stream_get_contents($client));
        $this->assertLessThanOrEqual(NatsProbe::MAX_LINE_BYTES + 1, $written - $unread, 'at most one line-limit of the flood was read');
    }

    // ---- the policy -------------------------------------------------------------------------------------------------

    public function test_the_policy_requires_tls_for_a_tls_address_or_a_verified_public_nats_address(): void
    {
        $public = new OutboundTarget(true, 'nats', 'nats.example.com', 4222, ['93.184.216.34']);
        $private = new OutboundTarget(true, 'nats', 'nats.internal', 4222, ['10.0.0.9'], private: true);

        $this->assertTrue(TlsPolicy::for(NatsEndpoint::parse('tls://nats.example.com'), $private, false, null)->required, 'tls:// always');
        $this->assertTrue(TlsPolicy::for(NatsEndpoint::parse('nats://nats.example.com'), $public, true, null)->required, 'verified + public');
        $this->assertFalse(TlsPolicy::for(NatsEndpoint::parse('nats://nats.example.com'), $public, false, null)->required, 'verification switched off');
        $this->assertFalse(TlsPolicy::for(NatsEndpoint::parse('nats://nats.internal'), $private, true, null)->required, 'private network');
    }

    public function test_the_policy_carries_the_host_name_and_the_ca_file(): void
    {
        $policy = TlsPolicy::for(NatsEndpoint::parse('tls://nats.example.com:4222'), new OutboundTarget(true, 'tls', 'nats.example.com', 4222, ['93.184.216.34']), true, ' /etc/ssl/nats-ca.pem ');

        $this->assertSame('nats.example.com', $policy->peerName);
        $this->assertSame('/etc/ssl/nats-ca.pem', $policy->caFile);
        $this->assertTrue($policy->verifyPeer);
        $this->assertNull(TlsPolicy::for(NatsEndpoint::parse('tls://nats.example.com'), new OutboundTarget(true), true, '  ')->caFile);
    }
}
