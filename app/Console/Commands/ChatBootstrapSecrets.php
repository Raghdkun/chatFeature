<?php

namespace App\Console\Commands;

use App\Domain\Install\InstallState;
use App\Domain\Install\Support\EnvFile;
use Illuminate\Console\Command;
use Illuminate\Encryption\Encrypter;
use Illuminate\Support\Str;
use Minishlink\WebPush\VAPID;
use Throwable;

/**
 * Generates every secret a fresh deployment needs and writes it to `.env` (or `--env-file=`).
 * Idempotent: values that already exist are never touched. Used by the Docker entrypoint and
 * by developers before the first `serve`.
 */
class ChatBootstrapSecrets extends Command
{
    protected $signature = 'chat:bootstrap-secrets
        {--env-file= : Env file to read and write (default: the application .env)}';

    protected $description = 'Generate missing APP_KEY, Reverb, VAPID and setup-token secrets in .env (idempotent)';

    public function handle(InstallState $install): int
    {
        $option = $this->option('env-file');
        $path = is_string($option) && $option !== '' ? $option : base_path('.env');
        $env = new EnvFile($path);

        if (! $env->exists() && ! $this->seedFromExample($path)) {
            file_put_contents($path, '');
            chmod($path, 0600);
        }

        $generated = [];

        if (! $env->has('APP_KEY')) {
            $cipher = config('app.cipher');
            $generated['APP_KEY'] = 'base64:'.base64_encode(Encrypter::generateKey(is_string($cipher) ? $cipher : 'AES-256-CBC'));
        }

        if (! $env->has('REVERB_APP_ID')) {
            $generated['REVERB_APP_ID'] = (string) random_int(100000, 999999);
        }

        foreach (['REVERB_APP_KEY', 'REVERB_APP_SECRET'] as $key) {
            if (! $env->has($key)) {
                $generated[$key] = Str::lower(Str::random(20));
            }
        }

        $generated += $this->vapidKeys($env);

        $installed = $install->isInstalled();

        if (! $installed && ! $env->has('SETUP_TOKEN')) {
            $generated['SETUP_TOKEN'] = Str::random(32);
        }

        if ($generated !== []) {
            $env->set($generated);
        }

        $this->components->info($generated === []
            ? 'Nothing to do: every secret already exists in '.$path.'.'
            : 'Generated '.implode(', ', array_keys($generated)).' in '.$path.'.');

        if (! $installed) {
            $token = $generated['SETUP_TOKEN'] ?? $env->get('SETUP_TOKEN');

            $this->line('Setup token (needed on the /setup screen unless APP_ENV=local): '.$token);
        }

        if (is_file(base_path('bootstrap/cache/config.php'))) {
            $this->components->warn('The configuration is cached: run "php artisan config:clear" so the new values are picked up.');
        }

        return self::SUCCESS;
    }

    /**
     * @return array<string, string>
     */
    private function vapidKeys(EnvFile $env): array
    {
        if (! class_exists(VAPID::class) || ($env->has('VAPID_PUBLIC_KEY') && $env->has('VAPID_PRIVATE_KEY'))) {
            return [];
        }

        if ($env->has('VAPID_PUBLIC_KEY') || $env->has('VAPID_PRIVATE_KEY')) {
            $this->components->warn('Only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set; leaving both untouched.');

            return [];
        }

        try {
            $keys = VAPID::createVapidKeys();
        } catch (Throwable $exception) {
            $this->components->warn('Could not generate VAPID keys: '.$exception->getMessage());

            return [];
        }

        return ['VAPID_PUBLIC_KEY' => $keys['publicKey'], 'VAPID_PRIVATE_KEY' => $keys['privateKey']];
    }

    private function seedFromExample(string $path): bool
    {
        $example = base_path('.env.example');

        if (basename($path) !== '.env' || ! is_file($example)) {
            return false;
        }

        return copy($example, $path) && chmod($path, 0600);
    }
}
