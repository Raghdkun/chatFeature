<?php

namespace App\Http\Controllers\Setup;

use App\Domain\Install\Actions\BuildSetupData;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\SetupTokenManager;
use App\Http\Controllers\Controller;
use App\Http\Requests\Setup\ChooseModeRequest;
use App\Http\Requests\Setup\StoreAdminRequest;
use App\Http\Requests\Setup\StoreBasicsRequest;
use App\Http\Requests\Setup\VerifySetupTokenRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The guest-only, pre-install setup wizard (docs/contracts/setup-wizard.md). Works with no
 * database: answers live in install-state.json, the session is file based.
 */
class SetupController extends Controller
{
    public function __construct(
        private readonly BuildSetupData $buildSetupData,
        private readonly StoreInstallAnswers $answers,
        private readonly SetupTokenManager $token,
        private readonly InstallRunner $runner,
    ) {}

    /**
     * Render the wizard; the server picks the step (`?step=` may go back to an earlier one).
     */
    public function index(Request $request): Response
    {
        $step = $request->query('step');

        return Inertia::render('setup/index', [
            'setup' => ($this->buildSetupData)($request, is_string($step) ? $step : null),
        ]);
    }

    /**
     * JSON snapshot of the `setup` prop, for polling and resume.
     */
    public function state(Request $request): JsonResponse
    {
        return response()->json(['setup' => ($this->buildSetupData)($request)]);
    }

    /**
     * Verify the one-time setup token (throttled by the route).
     */
    public function token(VerifySetupTokenRequest $request): RedirectResponse
    {
        if ($this->token->isMisconfigured()) {
            throw ValidationException::withMessages([
                'token' => __('No setup token is configured on this server. Run "php artisan chat:bootstrap-secrets", restart the app and try again.'),
            ]);
        }

        if (! $this->token->verify((string) $request->validated('token'))) {
            throw ValidationException::withMessages(['token' => __('That setup token is not correct.')]);
        }

        // New session id once the privilege level changes (session fixation).
        $request->session()->regenerate();
        $this->token->markVerified($request->session());

        return to_route('setup.index');
    }

    public function mode(ChooseModeRequest $request): RedirectResponse
    {
        $this->answers->mode((string) $request->validated('mode'));

        return to_route('setup.index');
    }

    public function admin(StoreAdminRequest $request): RedirectResponse
    {
        $this->answers->admin(
            (string) $request->validated('name'),
            (string) $request->validated('email'),
            (string) $request->validated('password'),
        );

        return to_route('setup.index');
    }

    public function basics(StoreBasicsRequest $request): RedirectResponse
    {
        $this->answers->basics([
            'app_name' => (string) $request->validated('app_name'),
            'app_url' => rtrim((string) $request->validated('app_url'), '/'),
            'locale' => (string) $request->validated('locale'),
            'timezone' => (string) $request->validated('timezone'),
            'idle_timeout_minutes' => (int) $request->validated('idle_timeout_minutes'),
        ]);

        return to_route('setup.index');
    }

    /**
     * Run ONE install step. 200 for ok and failed, 409 while another run holds the lock.
     */
    public function run(string $step): JsonResponse
    {
        abort_unless(in_array($step, InstallRunner::RUN_STEPS, true), 404);

        try {
            $report = $this->runner->runStep($step);
        } catch (InstallBusyException $exception) {
            return response()->json(['status' => 'failed', 'message' => $exception->getMessage()], 409);
        }

        if (! $report->result->isOk()) {
            return response()->json(array_filter([
                'status' => 'failed',
                'message' => $report->result->message,
                'fields' => $report->result->fields === [] ? null : $report->result->fields,
            ], fn (mixed $value): bool => $value !== null));
        }

        $body = ['status' => 'ok', 'next' => $report->installed ? null : $report->next];

        if ($report->installed) {
            $body['redirect'] = route('login', absolute: false);
        }

        if ($report->result->message !== null) {
            $body['message'] = $report->result->message;
        }

        return response()->json($body);
    }
}
