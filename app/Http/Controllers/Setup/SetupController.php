<?php

namespace App\Http\Controllers\Setup;

use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Roles\RoleMapping;
use App\Domain\Install\Actions\BuildSetupData;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Domain\Install\Actions\VerifyPortalAdmin;
use App\Domain\Install\Exceptions\InstallBusyException;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\InstallState;
use App\Domain\Install\SetupTokenManager;
use App\Domain\Install\Support\PizzasysAnswers;
use App\Http\Controllers\Controller;
use App\Http\Requests\Setup\ChooseModeRequest;
use App\Http\Requests\Setup\PortalAdminRequest;
use App\Http\Requests\Setup\SavePizzasysRequest;
use App\Http\Requests\Setup\StoreAdminRequest;
use App\Http\Requests\Setup\StoreBasicsRequest;
use App\Http\Requests\Setup\TestPizzasysRequest;
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
        private readonly InstallState $state,
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

    /**
     * Mode 2: the portal environments, the active one and the role mapping (tokens are stored encrypted).
     */
    public function pizzasys(SavePizzasysRequest $request): RedirectResponse
    {
        /** @var list<string> $superRoles */
        $superRoles = array_values(array_unique(array_map('strval', (array) $request->validated('super_roles'))));

        $this->answers->pizzasys(
            $request->environmentAnswers(),
            (string) $request->validated('active_env'),
            new RoleMapping((string) $request->validated('admin_permission'), (string) $request->validated('agent_permission'), $superRoles),
        );

        return to_route('setup.index');
    }

    /**
     * Mode 2: test one saved environment (reachable, service credential, latency, NATS). Never echoes a token.
     */
    public function testPizzasys(TestPizzasysRequest $request, TestPortalConnection $test): JsonResponse
    {
        $key = (string) $request->validated('env');
        $answers = PizzasysAnswers::from($this->state->read()['auth_environments']);
        $endpoint = $answers->endpoint($key);

        if ($endpoint === null) {
            throw ValidationException::withMessages(['env' => __('Save the :env environment first.', ['env' => $key])]);
        }

        $environment = $answers->environment($key);
        $result = $test($endpoint, $environment['nats_url'] ?? null, $answers->natsToken($key));

        $this->answers->markTested($key, $result->ok);

        return response()->json($result->toArray());
    }

    /**
     * Mode 2: sign in as the portal administrator who will own the app. Failures are 422 with a `code`.
     */
    public function portalAdmin(PortalAdminRequest $request, VerifyPortalAdmin $verify): JsonResponse
    {
        $outcome = $verify((string) $request->validated('email'), (string) $request->validated('password'));

        if (! $outcome['ok']) {
            return response()->json(['ok' => false, 'message' => $outcome['message'], 'code' => $outcome['code']], 422);
        }

        return response()->json(['ok' => true, 'user' => ['name' => $outcome['name'], 'email' => $outcome['email']], 'isAdmin' => true]);
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
