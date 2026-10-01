<?php

namespace App\Console\Commands;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\InstallState;
use App\Domain\Install\StepReport;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;

/**
 * Non-interactive install for Docker provisioning and e2e: runs the same steps as the wizard,
 * with the answers taken from the environment (see config/install.php, `cli`).
 *
 *   INSTALL_ADMIN_NAME, INSTALL_ADMIN_EMAIL, INSTALL_ADMIN_PASSWORD,
 *   INSTALL_APP_NAME, INSTALL_APP_URL, INSTALL_LOCALE, INSTALL_TIMEZONE, INSTALL_IDLE_TIMEOUT_MINUTES
 */
class ChatInstall extends Command
{
    protected $signature = 'chat:install
        {--mode=local : Authentication mode: local (Fortify) or pizzasys}';

    protected $description = 'Install non-interactively from INSTALL_* environment variables';

    public function handle(InstallState $install, InstallRunner $runner, StoreInstallAnswers $answers): int
    {
        $mode = match ((string) $this->option('mode')) {
            'local', 'fortify' => AuthMode::Fortify,
            'pizzasys' => AuthMode::Pizzasys,
            default => null,
        };

        if ($mode === null) {
            $this->components->error('Unknown mode. Use --mode=local or --mode=pizzasys.');

            return self::FAILURE;
        }

        if ($mode === AuthMode::Pizzasys) {
            $this->components->error('The pizzasys mode is available in P2 and cannot be installed non-interactively yet.');

            return self::FAILURE;
        }

        if ($install->isInstalled()) {
            $this->components->info('Already installed; nothing to do.');

            return self::SUCCESS;
        }

        $problems = $this->storeAnswers($install, $answers, $mode);

        if ($problems !== []) {
            foreach ($problems as $problem) {
                $this->components->error($problem);
            }

            return self::FAILURE;
        }

        try {
            $reports = $runner->runAll(
                fn (StepReport $report) => $this->report($report),
            );
        } catch (InstallBusyException $exception) {
            $this->components->error($exception->getMessage());

            return self::FAILURE;
        }

        $last = $reports === [] ? null : end($reports);

        if ($last === null || ! ($last->result->isOk())) {
            return self::FAILURE;
        }

        $url = $install->read()['basics']['app_url'] ?? config('app.url');
        $this->components->info('Installed. Sign in at '.rtrim((string) $url, '/').'/login');

        return self::SUCCESS;
    }

    /**
     * @return list<string> Validation problems (empty when the answers are stored).
     */
    private function storeAnswers(InstallState $install, StoreInstallAnswers $answers, AuthMode $mode): array
    {
        $cli = (array) config('install.cli', []);
        $problems = [];

        $answers->mode($mode->value);

        $email = $cli['admin_email'] ?? null;
        $password = $cli['admin_password'] ?? null;

        if (is_string($email) && $email !== '' && is_string($password) && $password !== '') {
            $name = is_string($cli['admin_name'] ?? null) && $cli['admin_name'] !== '' ? $cli['admin_name'] : 'Administrator';

            $validator = Validator::make(
                ['name' => $name, 'email' => $email, 'password' => $password],
                ['name' => ['required', 'string', 'max:255'], 'email' => ['required', 'email', 'max:255'], 'password' => ['required', 'string', Password::default()]],
            );

            if ($validator->fails()) {
                foreach ($validator->errors()->all() as $message) {
                    $problems[] = 'INSTALL_ADMIN_*: '.$message;
                }
            } else {
                $answers->admin($name, $email, $password);
            }
        } elseif ($install->read()['admin'] === null) {
            $problems[] = 'Set INSTALL_ADMIN_EMAIL and INSTALL_ADMIN_PASSWORD (and optionally INSTALL_ADMIN_NAME) for the first administrator.';
        }

        $basics = array_filter([
            'app_name' => $cli['app_name'] ?? null,
            'app_url' => $cli['app_url'] ?? null,
            'locale' => $cli['locale'] ?? null,
            'timezone' => $cli['timezone'] ?? null,
            'idle_timeout_minutes' => $cli['idle_timeout_minutes'] ?? null,
        ], fn (mixed $value): bool => $value !== null && $value !== '') + ($install->read()['basics'] ?? StoreInstallAnswers::defaultBasics());

        $validator = Validator::make($basics, [
            'app_name' => ['required', 'string', 'max:100'],
            'app_url' => ['required', 'string', 'url:http,https', 'max:255'],
            'locale' => ['required', 'string', Rule::in((array) config('chat.locales', ['en']))],
            'timezone' => ['required', 'string', 'timezone:all'],
            'idle_timeout_minutes' => ['required', 'integer', 'min:1', 'max:10080'],
        ]);

        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $message) {
                $problems[] = 'INSTALL_*: '.$message;
            }
        } else {
            $answers->basics([
                'app_name' => (string) $basics['app_name'],
                'app_url' => rtrim((string) $basics['app_url'], '/'),
                'locale' => (string) $basics['locale'],
                'timezone' => (string) $basics['timezone'],
                'idle_timeout_minutes' => (int) $basics['idle_timeout_minutes'],
            ]);
        }

        return $problems;
    }

    private function report(StepReport $report): void
    {
        $message = $report->result->message !== null ? ' - '.$report->result->message : '';

        $report->result->isOk()
            ? $this->components->twoColumnDetail($report->key, '<info>ok</info>'.$message)
            : $this->components->twoColumnDetail($report->key, '<error>failed</error>'.$message);
    }
}
