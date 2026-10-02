<?php

namespace App\Console\Commands;

use App\Support\ApiDocs\ApiAudience;
use App\Support\ApiDocs\ApiDocsAudit;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Knuckles\Scribe\Scribe;
use Symfony\Component\Process\Process;

/**
 * Builds the API reference of both audiences with Scribe: static HTML under `public/docs/{management,public}` (git-ignored) and the
 * OpenAPI files `docs/api/openapi-{management,public}.yaml` (committed, small enough to review). Scribe runs in a child process with a
 * fixed environment (an empty install state, an in-memory database, array cache and session, a placeholder `APP_URL`), so the result
 * is offline, needs no running server and no secrets, never touches the installation's database and does not depend on where it ran.
 *
 * `--check` builds into a temporary directory and fails when a committed file differs: the CI form of "the reference is current".
 */
class ApiDocsCommand extends Command
{
    protected $signature = 'docs:api
        {--check : Build into a temporary directory and fail when a committed OpenAPI file is out of date}
        {--only= : Build one reference only: management or public}';

    protected $description = 'Generate the API reference (HTML under public/docs, OpenAPI files under docs/api)';

    public function handle(): int
    {
        if (! class_exists(Scribe::class)) {
            $this->components->error('Scribe is a development dependency and is not installed (composer install --no-dev).');

            return self::FAILURE;
        }

        $only = $this->option('only');
        $audiences = array_values(array_filter(ApiAudience::cases(), static fn (ApiAudience $audience): bool => $only === null || $only === '' || $audience->value === $only));

        if ($audiences === []) {
            $this->components->error('--only must be management or public.');

            return self::FAILURE;
        }

        $problems = ApiDocsAudit::problems();

        if ($problems !== []) {
            $this->components->error('The reference is incomplete:');

            foreach ($problems as $problem) {
                $this->line('  - '.$problem);
            }

            return self::FAILURE;
        }

        $check = (bool) $this->option('check');
        $work = sys_get_temp_dir().'/api-docs-'.Str::random(10);
        File::ensureDirectoryExists($work.'/install');
        $stale = [];

        try {
            foreach ($audiences as $audience) {
                $html = $check ? $work.'/html/'.$audience->value : $audience->htmlPath();
                $spec = $this->build($audience, $html, $work);

                if ($spec === null) {
                    return self::FAILURE;
                }

                if ($check) {
                    $committed = is_file($audience->specPath()) ? (string) file_get_contents($audience->specPath()) : '';

                    if ($committed !== $spec) {
                        $stale[] = $audience->specPath();
                    }

                    continue;
                }

                File::ensureDirectoryExists(dirname($audience->specPath()));
                file_put_contents($audience->specPath(), $spec);
                $this->components->info(sprintf('%s: %s (%d lines), HTML in %s', $audience->value, str_replace(base_path().'/', '', $audience->specPath()), substr_count($spec, "\n"), $html));
            }
        } finally {
            File::deleteDirectory($work);
        }

        if ($stale !== []) {
            $this->components->error('Out of date, run `composer docs:api` and commit the result:');

            foreach ($stale as $file) {
                $this->line('  - '.str_replace(base_path().'/', '', $file));
            }

            return self::FAILURE;
        }

        if ($check) {
            $this->components->info('The committed OpenAPI files are current.');
        }

        return self::SUCCESS;
    }

    /** Runs `scribe:generate` for one audience and returns the OpenAPI file it wrote, `null` on failure. */
    private function build(ApiAudience $audience, string $htmlPath, string $work): ?string
    {
        $process = new Process(
            [PHP_BINARY, base_path('artisan'), 'scribe:generate', '--config='.$audience->configName(), '--force', '--no-interaction', '--no-upgrade-check', '--scribe-dir='.$work.'/scribe/'.$audience->value],
            base_path(),
            $this->environment($audience, $htmlPath, $work),
            null,
            300,
        );
        $process->run();

        if (! $process->isSuccessful()) {
            $this->components->error('scribe:generate failed for '.$audience->value.':');
            $this->line($process->getErrorOutput().$process->getOutput());

            return null;
        }

        if ($this->output->isVerbose()) {
            $this->line($process->getOutput());
        }

        $path = (str_starts_with($htmlPath, '/') ? $htmlPath : base_path($htmlPath)).'/openapi.yaml';

        if (! is_file($path)) {
            $this->components->error('Scribe wrote no OpenAPI file for '.$audience->value.' ('.$path.').');
            $this->line($process->getOutput());

            return null;
        }

        return (string) file_get_contents($path);
    }

    /**
     * The child's environment: nothing of the installation it runs in can leak into the reference.
     *
     * @return array<string, string>
     */
    private function environment(ApiAudience $audience, string $htmlPath, string $work): array
    {
        return [
            'APP_ENV' => 'local',
            'APP_DEBUG' => 'false',
            'APP_URL' => 'https://chat.example.com',
            'APP_KEY' => (string) (config('app.key') ?: 'base64:'.base64_encode(str_repeat('0', 32))),
            'APP_INSTALLED' => 'false',
            'INSTALL_STATE_DIR' => $work.'/install',
            'DB_CONNECTION' => 'sqlite',
            'DB_DATABASE' => ':memory:',
            'DB_URL' => '',
            'CACHE_STORE' => 'array',
            'SESSION_DRIVER' => 'array',
            'QUEUE_CONNECTION' => 'sync',
            'BROADCAST_CONNECTION' => 'null',
            'MAIL_MAILER' => 'array',
            'LOG_CHANNEL' => 'null',
            'API_DOCS_OUTPUT_'.strtoupper($audience->value) => $htmlPath,
        ];
    }
}
