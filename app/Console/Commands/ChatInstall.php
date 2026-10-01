<?php

namespace App\Console\Commands;

use App\Auth\Enums\AuthMode;
use App\Auth\Roles\RoleMapping;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Domain\Install\Actions\VerifyPortalAdmin;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\InstallState;
use App\Domain\Install\StepReport;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
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
 *
 * Mode `pizzasys` takes the portal instead of a local administrator (the administrator's login is verified live, the
 * password is used for that check only):
 *   INSTALL_AUTH_BASE_URL, INSTALL_AUTH_SERVICE_NAME, INSTALL_AUTH_SERVICE_TOKEN, INSTALL_AUTH_ADMIN_EMAIL,
 *   INSTALL_AUTH_ADMIN_PASSWORD, optional INSTALL_AUTH_API_PREFIX, INSTALL_AUTH_NATS_URL, INSTALL_AUTH_NATS_TOKEN,
 *   INSTALL_AUTH_VERIFY_TLS, INSTALL_AUTH_ADMIN_PERMISSION, INSTALL_AUTH_AGENT_PERMISSION, INSTALL_AUTH_SUPER_ROLES
 *   (comma separated).
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

        if ($mode === AuthMode::Pizzasys) {
            array_push($problems, ...$this->storePortalAnswers($answers));
        } else {
            array_push($problems, ...$this->storeLocalAdmin($install, $answers, $cli));
        }

        array_push($problems, ...$this->storeBasics($install, $answers, $cli));

        return $problems;
    }

    /**
     * @param  array<string, mixed>  $cli
     * @return list<string>
     */
    private function storeLocalAdmin(InstallState $install, StoreInstallAnswers $answers, array $cli): array
    {
        $problems = [];
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

        return $problems;
    }

    /**
     * @param  array<string, mixed>  $cli
     * @return list<string>
     */
    private function storeBasics(InstallState $install, StoreInstallAnswers $answers, array $cli): array
    {
        $problems = [];

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
            'idle_timeout_minutes' => ['required', 'integer', 'min:5', 'max:10080'],
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

    /**
     * Mode 2: store the portal answers and verify the portal administrator's login live.
     *
     * @return list<string>
     */
    private function storePortalAnswers(StoreInstallAnswers $answers): array
    {
        $auth = (array) config('install.cli.auth', []);
        $value = fn (string $key): ?string => is_string($auth[$key] ?? null) && trim((string) $auth[$key]) !== '' ? trim((string) $auth[$key]) : null;

        $input = [
            'base_url' => $value('base_url'),
            'service_name' => $value('service_name'),
            'service_token' => $value('service_token'),
            'nats_url' => $value('nats_url'),
            'nats_token' => $value('nats_token'),
            'admin_email' => $value('admin_email'),
            'admin_password' => $value('admin_password'),
        ];

        $validator = Validator::make($input, [
            'base_url' => ['required', 'string', new PortalUrl],
            'service_name' => ['required', 'string', 'regex:/^[A-Za-z0-9._-]{1,64}$/'],
            'service_token' => ['required', 'string', 'max:512'],
            'nats_url' => ['nullable', 'string', new NatsUrl],
            'nats_token' => ['nullable', 'string', 'max:512'],
            'admin_email' => ['required', 'email', 'max:255'],
            'admin_password' => ['required', 'string', 'max:255'],
        ]);

        if ($validator->fails()) {
            return array_values(array_map(fn (string $message): string => 'INSTALL_AUTH_*: '.$message, $validator->errors()->all()));
        }

        $defaults = new RoleMapping;
        $supers = $value('super_roles');
        $prefix = $value('api_prefix');

        $answers->pizzasys(
            [
                'production' => [
                    'base_url' => (string) $input['base_url'],
                    'api_prefix' => $prefix !== null ? '/'.trim($prefix, '/') : '/api/v1',
                    'service_name' => (string) $input['service_name'],
                    'service_token' => $input['service_token'],
                    'nats_url' => $input['nats_url'],
                    'nats_token' => $input['nats_token'],
                    'verify_tls' => ! in_array(strtolower((string) $value('verify_tls')), ['0', 'false', 'no', 'off'], true),
                ],
            ],
            'production',
            new RoleMapping(
                $value('admin_permission') ?? $defaults->adminPermission,
                $value('agent_permission') ?? $defaults->agentPermission,
                $supers !== null ? array_values(array_filter(array_map('trim', explode(',', $supers)))) : $defaults->superRoles,
            ),
        );

        $outcome = app(VerifyPortalAdmin::class)((string) $input['admin_email'], (string) $input['admin_password']);

        return $outcome['ok'] ? [] : ['Portal administrator check failed ('.$outcome['code'].'): '.$outcome['message']];
    }

    private function report(StepReport $report): void
    {
        $message = $report->result->message !== null ? ' - '.$report->result->message : '';

        $report->result->isOk()
            ? $this->components->twoColumnDetail($report->key, '<info>ok</info>'.$message)
            : $this->components->twoColumnDetail($report->key, '<error>failed</error>'.$message);
    }
}
