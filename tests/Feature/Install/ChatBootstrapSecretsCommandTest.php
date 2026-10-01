<?php

namespace Tests\Feature\Install;

use App\Domain\Install\Support\EnvFile;

class ChatBootstrapSecretsCommandTest extends InstallTestCase
{
    private string $envFile;

    protected function setUp(): void
    {
        parent::setUp();

        $this->envFile = $this->install->directory().'/test.env';
    }

    public function test_it_generates_every_missing_secret_and_prints_the_setup_token(): void
    {
        file_put_contents($this->envFile, "APP_NAME=\"PNE Chat\"\nAPP_KEY=\nSESSION_DRIVER=redis\n");

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])
            ->expectsOutputToContain('Generated APP_KEY')
            ->expectsOutputToContain('Setup token')
            ->assertExitCode(0);

        $env = new EnvFile($this->envFile);

        $this->assertStringStartsWith('base64:', (string) $env->get('APP_KEY'));
        $this->assertSame(32, strlen((string) base64_decode(substr((string) $env->get('APP_KEY'), 7), true)));
        $this->assertMatchesRegularExpression('/^\d{6}$/', (string) $env->get('REVERB_APP_ID'));
        $this->assertSame(20, strlen((string) $env->get('REVERB_APP_KEY')));
        $this->assertSame(20, strlen((string) $env->get('REVERB_APP_SECRET')));
        $this->assertNotSame('', (string) $env->get('VAPID_PUBLIC_KEY'));
        $this->assertNotSame('', (string) $env->get('VAPID_PRIVATE_KEY'));
        $this->assertSame(32, strlen((string) $env->get('SETUP_TOKEN')));

        // everything else in the file is untouched
        $this->assertSame('PNE Chat', $env->get('APP_NAME'));
        $this->assertSame('redis', $env->get('SESSION_DRIVER'));
    }

    public function test_it_is_idempotent(): void
    {
        file_put_contents($this->envFile, "APP_KEY=\n");
        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])->assertExitCode(0);
        $first = (string) file_get_contents($this->envFile);

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])
            ->expectsOutputToContain('Nothing to do')
            ->assertExitCode(0);

        $this->assertSame($first, (string) file_get_contents($this->envFile));
    }

    public function test_it_prints_the_existing_token_on_a_second_run_without_regenerating_it(): void
    {
        file_put_contents($this->envFile, '');
        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile]);
        $token = (string) (new EnvFile($this->envFile))->get('SETUP_TOKEN');

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])
            ->expectsOutputToContain($token)
            ->assertExitCode(0);

        $this->assertSame($token, (new EnvFile($this->envFile))->get('SETUP_TOKEN'));
    }

    public function test_it_never_overwrites_values_that_exist(): void
    {
        file_put_contents($this->envFile, "APP_KEY=base64:keep-me\nREVERB_APP_ID=42\nREVERB_APP_KEY=mykey\nREVERB_APP_SECRET=mysecret\nVAPID_PUBLIC_KEY=pub\nVAPID_PRIVATE_KEY=priv\nSETUP_TOKEN=tok\n");

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])->assertExitCode(0);

        $env = new EnvFile($this->envFile);
        $this->assertSame('base64:keep-me', $env->get('APP_KEY'));
        $this->assertSame('42', $env->get('REVERB_APP_ID'));
        $this->assertSame('mysecret', $env->get('REVERB_APP_SECRET'));
        $this->assertSame('pub', $env->get('VAPID_PUBLIC_KEY'));
        $this->assertSame('tok', $env->get('SETUP_TOKEN'));
    }

    public function test_it_does_not_mint_a_setup_token_for_an_installed_app(): void
    {
        $this->install->writeLock();
        file_put_contents($this->envFile, "APP_KEY=base64:keep-me\n");

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])
            ->doesntExpectOutputToContain('Setup token')
            ->assertExitCode(0);

        $this->assertNull((new EnvFile($this->envFile))->get('SETUP_TOKEN'));
    }

    public function test_it_creates_the_env_file_when_it_does_not_exist(): void
    {
        $this->assertFileDoesNotExist($this->envFile);

        $this->artisan('chat:bootstrap-secrets', ['--env-file' => $this->envFile])->assertExitCode(0);

        $this->assertFileExists($this->envFile);
        $this->assertTrue((new EnvFile($this->envFile))->has('APP_KEY'));
    }
}
