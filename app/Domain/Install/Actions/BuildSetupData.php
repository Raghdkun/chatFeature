<?php

namespace App\Domain\Install\Actions;

use App\Auth\Enums\AuthMode;
use App\Data\Auth\EnvironmentKey;
use App\Data\Auth\PizzasysEnvironmentData;
use App\Data\Auth\PizzasysEnvironmentsData;
use App\Data\Auth\PizzasysPortalAdminData;
use App\Data\Auth\PizzasysRolesData;
use App\Data\Auth\PizzasysSetupData;
use App\Data\Auth\PizzasysTestedData;
use App\Data\Setup\SetupAdminData;
use App\Data\Setup\SetupCheckData;
use App\Data\Setup\SetupData;
use App\Data\Setup\SetupDefaultsData;
use App\Data\Setup\SetupEnvironmentData;
use App\Data\Setup\SetupRunStatus;
use App\Data\Setup\SetupRunStepData;
use App\Data\Setup\SetupStepData;
use App\Data\Setup\SetupStepKey;
use App\Data\Setup\SetupStepStatus;
use App\Domain\Install\InstallLock;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\InstallState;
use App\Domain\Install\SetupTokenManager;
use App\Domain\Install\Support\EnvironmentChecker;
use App\Domain\Install\Support\PizzasysAnswers;
use Illuminate\Http\Request;
use Spatie\LaravelData\Optional;

/**
 * Builds the `setup` prop (docs/contracts/setup-wizard.md) from install-state.json and the
 * environment. Never reads the database.
 */
final class BuildSetupData
{
    /** Wizard screens in order; `admin` is for mode fortify only, `pizzasys` and `portal-admin` for mode pizzasys only. */
    private const ORDER = [
        SetupStepKey::Welcome,
        SetupStepKey::Mode,
        SetupStepKey::Admin,
        SetupStepKey::Pizzasys,
        SetupStepKey::PortalAdmin,
        SetupStepKey::Basics,
        SetupStepKey::Run,
        SetupStepKey::Done,
    ];

    public function __construct(
        private readonly InstallState $state,
        private readonly InstallRunner $runner,
        private readonly InstallLock $lock,
        private readonly SetupTokenManager $token,
        private readonly EnvironmentChecker $environment,
    ) {}

    /**
     * @param  string|null  $requestedStep  `?step=` query: lets the UI go back to an earlier screen.
     */
    public function __invoke(Request $request, ?string $requestedStep = null): SetupData
    {
        $data = $this->state->read();
        $needsToken = $this->token->isRequired();
        $verified = $this->token->isVerified($request->session());
        $checks = $this->environment->run();
        $environmentOk = EnvironmentChecker::passes($checks);
        $mode = AuthMode::tryFrom((string) $data['mode']);

        $pizzasys = PizzasysAnswers::from($data['auth_environments']);

        $current = $this->currentStep($needsToken, $verified, $environmentOk, $mode, $data['admin'] !== null, $pizzasys, $data['basics'] !== null, $data['run']);
        $requested = $requestedStep !== null ? SetupStepKey::tryFrom($requestedStep) : null;

        if ($requested !== null && $this->index($requested) < $this->index($current)) {
            $current = $requested;
        }

        return new SetupData(
            step: $current,
            steps: $this->progress($current, $mode),
            needsToken: $needsToken,
            tokenVerified: $verified,
            mode: $mode,
            pizzasysAvailable: config('install.pizzasys_available') === true,
            environment: new SetupEnvironmentData(
                ok: $environmentOk,
                checks: array_map(
                    // Details such as database error text are only for someone holding the setup token.
                    fn ($check): SetupCheckData => new SetupCheckData(
                        $check->key,
                        $check->label,
                        $check->ok,
                        $check->message !== null && $verified ? $check->message : new Optional,
                    ),
                    $checks,
                ),
            ),
            defaults: $this->defaults($request, $data['basics']),
            admin: $data['admin'] !== null ? new SetupAdminData($data['admin']['name'], $data['admin']['email']) : null,
            run: $this->run($mode, $data['run']),
            pizzasys: $mode === AuthMode::Pizzasys ? $this->pizzasys($pizzasys) : null,
        );
    }

    /**
     * @param  array<string, array{status: string, message: string|null}>  $run
     */
    private function currentStep(bool $needsToken, bool $verified, bool $environmentOk, ?AuthMode $mode, bool $hasAdmin, PizzasysAnswers $pizzasys, bool $hasBasics, array $run): SetupStepKey
    {
        return match (true) {
            ($needsToken && ! $verified) || ! $environmentOk => SetupStepKey::Welcome,
            $mode === null => SetupStepKey::Mode,
            $mode === AuthMode::Fortify && ! $hasAdmin => SetupStepKey::Admin,
            $mode === AuthMode::Pizzasys && ! $pizzasys->isConfigured() => SetupStepKey::Pizzasys,
            $mode === AuthMode::Pizzasys && $pizzasys->portalAdmin() === null => SetupStepKey::PortalAdmin,
            ! $hasBasics => SetupStepKey::Basics,
            $this->allRunStepsDone($mode, $run) => SetupStepKey::Done,
            default => SetupStepKey::Run,
        };
    }

    /**
     * @param  array<string, array{status: string, message: string|null}>  $run
     */
    private function allRunStepsDone(AuthMode $mode, array $run): bool
    {
        foreach ($this->runner->runKeys($mode->value) as $key) {
            if (($run[$key]['status'] ?? null) !== 'done') {
                return false;
            }
        }

        return true;
    }

    /**
     * @return list<SetupStepData>
     */
    private function progress(SetupStepKey $current, ?AuthMode $mode): array
    {
        $labels = [
            'welcome' => __('Welcome'),
            'mode' => __('Sign-in mode'),
            'admin' => __('Administrator'),
            'pizzasys' => __('Auth portal'),
            'portal-admin' => __('Portal administrator'),
            'basics' => __('Basics'),
            'run' => __('Install'),
            'done' => __('Done'),
        ];

        $steps = [];

        foreach (self::ORDER as $key) {
            if ($key === SetupStepKey::Admin && $mode !== null && $mode !== AuthMode::Fortify) {
                continue;
            }

            if (in_array($key, [SetupStepKey::Pizzasys, SetupStepKey::PortalAdmin], true) && $mode !== AuthMode::Pizzasys) {
                continue;
            }

            $steps[] = new SetupStepData(
                $key,
                $labels[$key->value],
                match (true) {
                    $key === $current => SetupStepStatus::Current,
                    $this->index($key) < $this->index($current) => SetupStepStatus::Done,
                    default => SetupStepStatus::Pending,
                },
            );
        }

        return $steps;
    }

    /**
     * @param  array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}|null  $basics
     */
    private function defaults(Request $request, ?array $basics): SetupDefaultsData
    {
        $values = $basics ?? [...StoreInstallAnswers::defaultBasics(), 'app_url' => rtrim($request->root(), '/')];

        return new SetupDefaultsData(
            $values['app_name'],
            $values['app_url'],
            $values['locale'],
            $values['timezone'],
            $values['idle_timeout_minutes'],
        );
    }

    /**
     * @param  array<string, array{status: string, message: string|null}>  $run
     * @return list<SetupRunStepData>
     */
    private function run(?AuthMode $mode, array $run): array
    {
        $labels = [];
        foreach ($this->runner->steps($mode->value ?? AuthMode::Fortify->value) as $step) {
            $labels[$step->key()] = __($step->label());
        }

        $running = $this->lock->isHeld();
        $rows = [];

        foreach ($this->runner->runKeys($mode->value ?? AuthMode::Fortify->value) as $key) {
            $stored = $run[$key] ?? ['status' => 'pending', 'message' => null];

            $status = match ($stored['status']) {
                'done' => SetupRunStatus::Done,
                'failed' => SetupRunStatus::Failed,
                // A "running" marker without a held lock is the leftover of a crashed run.
                'running' => $running ? SetupRunStatus::Running : SetupRunStatus::Pending,
                default => SetupRunStatus::Pending,
            };

            $rows[] = new SetupRunStepData(
                $key,
                $labels[$key] ?? $key,
                $status,
                $stored['message'] !== null && $status === SetupRunStatus::Failed ? $stored['message'] : new Optional,
            );
        }

        return $rows;
    }

    private function pizzasys(PizzasysAnswers $answers): PizzasysSetupData
    {
        $environment = function (string $key) use ($answers): PizzasysEnvironmentData {
            $answer = $answers->environment($key);
            $enum = EnvironmentKey::from($key);

            if ($answer === null) {
                return PizzasysEnvironmentData::unconfigured($enum);
            }

            return new PizzasysEnvironmentData(
                key: $enum,
                label: $answer['label'],
                configured: true,
                base_url: $answer['base_url'],
                service_name: $answer['service_name'],
                has_service_token: $answer['service_token'] !== null,
                nats_url: $answer['nats_url'],
                has_nats_token: $answer['nats_token'] !== null,
                verify_tls: $answer['verify_tls'],
                last_check_at: null,
                last_check_status: null,
                last_check_message: null,
            );
        };

        $roles = $answers->roles();
        $admin = $answers->portalAdmin();

        return new PizzasysSetupData(
            environments: new PizzasysEnvironmentsData($environment('production'), $environment('testing')),
            active_env: EnvironmentKey::from($answers->activeKey()),
            roles: new PizzasysRolesData($roles->adminPermission, $roles->agentPermission, $roles->superRoles),
            tested: new PizzasysTestedData($answers->tested('production'), $answers->tested('testing')),
            portal_admin: $admin !== null ? new PizzasysPortalAdminData($admin['name'], $admin['email']) : null,
        );
    }

    private function index(SetupStepKey $key): int
    {
        $position = array_search($key, self::ORDER, true);

        return $position === false ? 0 : $position;
    }
}
