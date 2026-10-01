<?php

namespace App\Domain\Install;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\Support\EnvironmentChecker;
use Closure;
use Illuminate\Contracts\Container\Container;
use InvalidArgumentException;
use Throwable;

/**
 * Runs the registered InstallSteps. One step at a time, guarded by the `install.running` flock
 * (a second concurrent run gets InstallBusyException -> HTTP 409), outcome recorded in
 * install-state.json so a failed or interrupted run can simply be repeated.
 */
final class InstallRunner
{
    /** Steps the wizard's progress screen drives through `POST /setup/run/{step}`, in order. */
    public const RUN_STEPS = ['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'];

    /** @var list<InstallStep>|null */
    private ?array $resolved = null;

    public function __construct(
        private readonly Container $container,
        private readonly InstallState $state,
        private readonly InstallLock $lock,
        private readonly EnvironmentChecker $environment,
    ) {}

    /**
     * All registered steps in execution order, optionally narrowed to those that apply to a mode.
     *
     * @return list<InstallStep>
     */
    public function steps(?string $mode = null): array
    {
        if ($this->resolved === null) {
            /** @var list<class-string<InstallStep>> $classes */
            $classes = array_values((array) config('install.steps', []));
            $this->resolved = array_map(fn (string $class): InstallStep => $this->container->make($class), $classes);
        }

        if ($mode === null) {
            return $this->resolved;
        }

        return array_values(array_filter(
            $this->resolved,
            fn (InstallStep $step): bool => $step->modes() === null || in_array($mode, $step->modes(), true),
        ));
    }

    public function find(string $key): ?InstallStep
    {
        foreach ($this->steps() as $step) {
            if ($step->key() === $key) {
                return $step;
            }
        }

        return null;
    }

    /**
     * Keys of the run-phase steps that apply to the given mode.
     *
     * @return list<string>
     */
    public function runKeys(?string $mode): array
    {
        $applicable = array_map(fn (InstallStep $step): string => $step->key(), $this->steps($mode));

        return array_values(array_filter(self::RUN_STEPS, fn (string $key): bool => in_array($key, $applicable, true)));
    }

    /**
     * Run one step under the run lock (the HTTP entry point).
     *
     * @param  (Closure(string): void)|null  $reporter
     *
     * @throws InstallBusyException
     */
    public function runStep(string $key, ?Closure $reporter = null): StepReport
    {
        return $this->lock->run(fn (): StepReport => $this->execute($key, $reporter));
    }

    /**
     * Run every step that applies to the chosen mode, in order, holding the lock for the whole run
     * (the CLI entry point). Stops at the first step that does not succeed.
     *
     * @param  (Closure(StepReport): void)|null  $onStep
     * @param  (Closure(string): void)|null  $reporter
     * @return list<StepReport>
     *
     * @throws InstallBusyException
     */
    public function runAll(?Closure $onStep = null, ?Closure $reporter = null): array
    {
        return $this->lock->run(function () use ($onStep, $reporter): array {
            $reports = [];

            foreach ($this->steps($this->state->mode()) as $step) {
                if ($this->state->isInstalled()) {
                    break;
                }

                $report = $this->execute($step->key(), $reporter);
                $reports[] = $report;

                if ($onStep !== null) {
                    $onStep($report);
                }

                if (! $report->result->isOk()) {
                    break;
                }
            }

            return $reports;
        });
    }

    private function execute(string $key, ?Closure $reporter): StepReport
    {
        $step = $this->find($key) ?? throw new InvalidArgumentException("Unknown install step [{$key}].");

        if ($this->state->isInstalled()) {
            return new StepReport($key, StepResult::ok('Already installed.'), null, true);
        }

        $mode = $this->state->mode();

        if ($step->modes() !== null && ($mode === null || ! in_array($mode, $step->modes(), true))) {
            return new StepReport($key, StepResult::ok('Skipped for this mode.'), $this->nextAfter($key, $mode), false);
        }

        $blocked = $this->preflight($key, $mode);

        if ($blocked !== null) {
            $this->state->markRun($key, 'failed', $blocked->message);

            return new StepReport($key, $blocked, null, false);
        }

        $this->state->markRun($key, 'running');

        try {
            $result = $step->run(InstallContext::fromState($this->state, $reporter));
        } catch (Throwable $exception) {
            report($exception);

            $result = StepResult::failed(
                'The step failed unexpectedly: '.mb_substr(trim((string) strtok($exception->getMessage(), "\n")), 0, 300),
            );
        }

        $this->state->markRun($key, $result->isOk() ? 'done' : 'failed', $result->message);

        $installed = $this->state->isInstalled();

        return new StepReport($key, $result, $result->isOk() && ! $installed ? $this->nextAfter($key, $mode) : null, $installed);
    }

    /**
     * The run-phase steps may only start once the wizard answers exist and earlier run steps are done.
     */
    private function preflight(string $key, ?string $mode): ?StepResult
    {
        $runKeys = $this->runKeys($mode);
        $position = array_search($key, $runKeys, true);

        if ($position === false) {
            return null;
        }

        $data = $this->state->read();
        $missing = [];

        if (AuthMode::tryFrom((string) $mode) === null) {
            $missing[] = 'mode';
        }

        if ($data['basics'] === null) {
            $missing[] = 'basics';
        }

        if ($mode === AuthMode::Fortify->value && $data['admin'] === null) {
            $missing[] = 'admin';
        }

        if ($missing !== []) {
            return StepResult::needsInput($missing);
        }

        if ($position === 0 && ! EnvironmentChecker::passes($this->environment->run())) {
            return StepResult::failed('The environment check has not passed yet. Fix the reported problems first.');
        }

        foreach (array_slice($runKeys, 0, (int) $position) as $earlier) {
            if (($data['run'][$earlier]['status'] ?? null) !== 'done') {
                return StepResult::failed("Complete the step \"{$earlier}\" first.");
            }
        }

        return null;
    }

    private function nextAfter(string $key, ?string $mode): ?string
    {
        $runKeys = $this->runKeys($mode);
        $position = array_search($key, $runKeys, true);

        if ($position === false) {
            return null;
        }

        return $runKeys[$position + 1] ?? null;
    }
}
