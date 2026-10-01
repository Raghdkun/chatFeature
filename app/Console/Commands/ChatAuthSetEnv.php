<?php

namespace App\Console\Commands;

use App\Auth\Pizzasys\Actions\EnvironmentInput;
use App\Auth\Pizzasys\Actions\SaveAuthEnvironment;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\SecretReentry;
use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Break-glass: edit an auth-portal environment without the dashboard and WITHOUT trying the portal first, for when a
 * wrong address or token locked everybody out of Settings > Auth.
 *
 * The same rule as the dashboard applies: a secret is never reused for a new destination, so changing the address,
 * the service name or the NATS address asks for the matching token again. Tokens are read from a file
 * (`--token-file`, `--nats-token-file`) or typed at a hidden prompt; they are never accepted as an argument, which
 * would leave them in the shell history and the process list. Nothing secret is printed.
 */
class ChatAuthSetEnv extends Command
{
    protected $signature = 'chat:auth:set-env
        {env : The environment to edit: production or testing}
        {--base-url= : The portal address, for example https://auth.example.com}
        {--service-name= : The service name registered in the portal}
        {--api-prefix= : The API path prefix (default /api/v1)}
        {--nats-url= : The NATS address, for example nats://nats.example.com:4222}
        {--clear-nats : Remove the NATS address and its token}
        {--verify-tls= : true or false: verify TLS certificates}
        {--token-file= : File that holds the service token (otherwise you are asked for it)}
        {--nats-token-file= : File that holds the NATS token (otherwise you are asked for it when it is needed)}';

    protected $description = 'Edit an auth-portal environment without the UI or network access (secrets from a file or a prompt, never from arguments)';

    public function handle(
        InstallState $install,
        SettingsRepository $settings,
        AuthEnvironmentRepository $environments,
        SaveAuthEnvironment $save,
    ): int {
        $key = (string) $this->argument('env');

        if (! in_array($key, AuthEnvironment::KEYS, true)) {
            $this->components->error('Use "production" or "testing".');

            return self::FAILURE;
        }

        if (! $install->isInstalled() || $settings->string('auth.mode', 'fortify') !== 'pizzasys') {
            $this->components->error('This application is not installed in pizzasys mode; there is nothing to edit.');

            return self::FAILURE;
        }

        $existing = $environments->find($key);
        $baseUrl = $this->text('base-url') ?? $existing?->base_url;
        $serviceName = $this->text('service-name') ?? $existing?->service_name;

        if ($baseUrl === null || $serviceName === null) {
            $this->components->error("The {$key} environment does not exist yet: pass --base-url and --service-name.");

            return self::FAILURE;
        }

        $natsUrl = $this->option('clear-nats') ? null : ($this->text('nats-url') ?? $existing?->nats_url);
        $verifyTls = $this->verifyTlsOption();

        if ($this->text('verify-tls') !== null && $verifyTls === null) {
            $this->components->error('--verify-tls takes true or false.');

            return self::FAILURE;
        }

        $validator = Validator::make(
            ['base_url' => $baseUrl, 'service_name' => $serviceName, 'nats_url' => $natsUrl, 'api_prefix' => $this->text('api-prefix')],
            [
                'base_url' => ['required', 'string', new PortalUrl],
                'service_name' => ['required', 'string', 'regex:/^[A-Za-z0-9._-]{1,64}$/'],
                'nats_url' => ['nullable', 'string', new NatsUrl],
                'api_prefix' => ['nullable', 'string', 'regex:#^/[A-Za-z0-9/_-]{0,63}$#'],
            ],
        );

        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $message) {
                $this->components->error($message);
            }

            return self::FAILURE;
        }

        $tokenFile = $this->text('token-file');
        $serviceToken = $tokenFile !== null ? $this->readTokenFile($tokenFile) : null;

        if ($tokenFile !== null && $serviceToken === null) {
            return self::FAILURE;
        }

        $natsTokenFile = $this->text('nats-token-file');
        $natsToken = $natsTokenFile !== null ? $this->readTokenFile($natsTokenFile) : null;

        if ($natsTokenFile !== null && $natsToken === null) {
            return self::FAILURE;
        }

        $input = new EnvironmentInput(
            baseUrl: $baseUrl,
            serviceName: $serviceName,
            apiPrefix: $this->text('api-prefix'),
            serviceToken: $serviceToken,
            natsUrl: $natsUrl,
            natsToken: $natsToken,
            natsTokenGiven: $natsToken !== null,
            verifyTls: $verifyTls,
        );

        // A secret that has to be typed again (new destination) or that does not exist yet.
        $needed = $existing === null ? [SecretReentry::SERVICE_TOKEN => true] : SecretReentry::missingForEnvironment($existing, $input);

        if (isset($needed[SecretReentry::SERVICE_TOKEN]) && $serviceToken === null) {
            $serviceToken = $this->promptSecret($existing === null ? 'Service token' : (string) $needed[SecretReentry::SERVICE_TOKEN]);

            if ($serviceToken === null) {
                $this->components->error('No service token given.');

                return self::FAILURE;
            }
        }

        if (isset($needed[SecretReentry::NATS_TOKEN]) && ! $input->natsTokenGiven) {
            if (! $this->input->isInteractive()) {
                $this->components->error((string) $needed[SecretReentry::NATS_TOKEN].' Pass --nats-token-file, or --clear-nats to remove the NATS address.');

                return self::FAILURE;
            }

            $natsToken = $this->promptSecret((string) $needed[SecretReentry::NATS_TOKEN].' Leave it empty to remove the token.') ?? '';
        }

        $input = new EnvironmentInput(
            baseUrl: $baseUrl,
            serviceName: $serviceName,
            apiPrefix: $this->text('api-prefix'),
            serviceToken: $serviceToken,
            natsUrl: $natsUrl,
            natsToken: $natsToken,
            natsTokenGiven: $natsToken !== null || isset($needed[SecretReentry::NATS_TOKEN]),
            verifyTls: $verifyTls,
        );

        try {
            $environment = $save($key, $input, null, 'cli', preflight: false);
        } catch (ValidationException $exception) {
            foreach ($exception->errors() as $messages) {
                foreach ($messages as $message) {
                    $this->components->error($message);
                }
            }

            return self::FAILURE;
        }

        $this->components->info("Saved the {$key} environment ({$environment->base_url}, service \"{$environment->service_name}\"). Nothing was tried against the portal: run \"php artisan chat:auth:test {$key}\" to check it.");

        return self::SUCCESS;
    }

    private function text(string $option): ?string
    {
        $value = $this->option($option);

        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }

    /** `true`, `false`, or null when not given or not understood (keep the stored value). */
    private function verifyTlsOption(): ?bool
    {
        return match (strtolower((string) $this->text('verify-tls'))) {
            '1', 'true', 'yes', 'on' => true,
            '0', 'false', 'no', 'off' => false,
            default => null,
        };
    }

    private function readTokenFile(string $path): ?string
    {
        if (! is_file($path) || ! is_readable($path)) {
            $this->components->error('The token file cannot be read.');

            return null;
        }

        $token = trim((string) file_get_contents($path));

        if ($token === '' || mb_strlen($token) > 512) {
            $this->components->error('The token file must hold one token of at most 512 characters.');

            return null;
        }

        if ((fileperms($path) & 0o077) !== 0) {
            $this->components->warn('The token file can be read by other users. Remove it once you are done.');
        }

        return $token;
    }

    private function promptSecret(string $question): ?string
    {
        if (! $this->input->isInteractive()) {
            return null;
        }

        $answer = $this->secret($question);

        return is_string($answer) && $answer !== '' ? $answer : null;
    }
}
