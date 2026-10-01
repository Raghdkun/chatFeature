<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Drivers\FortifyDriver;
use App\Auth\Drivers\PizzasysDriver;
use App\Auth\Pizzasys\Actions\ActivateEnvironment;
use App\Auth\Pizzasys\Actions\EnvironmentInput;
use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Pizzasys\NatsProbe;
use App\Auth\Pizzasys\PendingPortalLogin;
use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\PortalGateway;
use App\Auth\Pizzasys\Results\PortalLoginResult;
use App\Auth\Support\ApiAuthResult;
use App\Domain\Install\Actions\StoreInstallAnswers;
use App\Domain\Install\Actions\VerifyPortalAdmin;
use App\Domain\Install\SetupTokenManager;
use App\Infrastructure\Nats\NatsEndpoint;
use App\Infrastructure\Nats\NatsSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use ReflectionClass;
use ReflectionNamedType;
use ReflectionParameter;
use RuntimeException;
use SensitiveParameter;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;
use Throwable;

/**
 * Passwords and tokens must not end up in stack traces (error pages, logs, Nightwatch): every parameter that carries one
 * is marked #[SensitiveParameter]. A reflection scan keeps new code honest, and a few real exceptions prove that the
 * secret really is absent from a trace.
 */
class SensitiveParametersTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private const SECRET = 'S3cr3t-value-that-must-not-leak-9137';

    /** @var list<string> */
    private const SCANNED = ['Auth', 'Domain/Install', 'Infrastructure/Nats', 'Http/Requests/Auth', 'Http/Requests/Setup', 'Console/Commands', 'Models'];

    /**
     * Parameter names that carry a secret as text or an array of credentials.
     */
    private function carriesASecret(ReflectionParameter $parameter): bool
    {
        $type = $parameter->getType();

        if (! $type instanceof ReflectionNamedType || ! in_array($type->getName(), ['string', 'array', 'mixed'], true)) {
            return false;
        }

        // `$token` / `$password` / `$secret` / `$credentials`, but not the names of identifiers (`$sanctumTokenId`) or flags.
        return preg_match('/^(plain|plainPassword|password|pass|passwordHash|token|userToken|bearer|secret|candidate|credentials|natsToken|serviceToken|restartToken|accessToken)$/i', $parameter->getName()) === 1;
    }

    public function test_every_parameter_that_carries_a_password_or_token_is_marked_sensitive(): void
    {
        $missing = [];

        foreach (self::SCANNED as $directory) {
            foreach (glob(app_path($directory.'/*.php')) ?: [] as $file) {
                $this->scan($file, $missing);
            }

            foreach (glob(app_path($directory.'/*/*.php')) ?: [] as $file) {
                $this->scan($file, $missing);
            }
        }

        $this->assertSame([], $missing, 'Add #[SensitiveParameter] to: '.implode(', ', $missing));
    }

    /**
     * @param  list<string>  $missing
     */
    private function scan(string $file, array &$missing): void
    {
        $class = 'App\\'.str_replace(['/', '.php'], ['\\', ''], substr($file, strlen(app_path()) + 1));

        if (! class_exists($class) && ! interface_exists($class) && ! trait_exists($class)) {
            return;
        }

        foreach ((new ReflectionClass($class))->getMethods() as $method) {
            if ($method->getDeclaringClass()->getName() !== $class) {
                continue;
            }

            foreach ($method->getParameters() as $parameter) {
                if ($this->carriesASecret($parameter) && $parameter->getAttributes(SensitiveParameter::class) === []) {
                    $missing[] = $class.'::'.$method->getName().'($'.$parameter->getName().')';
                }
            }
        }
    }

    public function test_the_known_entry_points_are_marked(): void
    {
        $expected = [
            [PizzasysClient::class, 'login', 'password'],
            [PizzasysClient::class, 'verify', 'userToken'],
            [PizzasysClient::class, 'me', 'userToken'],
            [PizzasysClient::class, 'logout', 'userToken'],
            [PortalGateway::class, 'login', 'password'],
            [PortalGateway::class, 'verify', 'token'],
            [PizzasysDriver::class, 'attemptForApi', 'credentials'],
            [PizzasysDriver::class, 'authenticate', 'password'],
            [FortifyDriver::class, 'attemptForApi', 'credentials'],
            [AuthDriver::class, 'attemptForApi', 'credentials'],
            [TestPortalConnection::class, '__invoke', 'natsToken'],
            [NatsProbe::class, 'probe', 'token'],
            [NatsProbe::class, 'handshake', 'token'],
            [VerifyPortalAdmin::class, '__invoke', 'password'],
            [ActivateEnvironment::class, '__invoke', 'password'],
            [SetupTokenManager::class, 'verify', 'candidate'],
            [StoreInstallAnswers::class, 'admin', 'plainPassword'],
            [StoreInstallAnswers::class, 'pizzasys', 'environments'],
            [ApiAuthResult::class, '__construct', 'token'],
            [ApiAuthResult::class, 'ok', 'token'],
            [PortalLoginResult::class, '__construct', 'token'],
            [PendingPortalLogin::class, '__construct', 'token'],
            [PizzasysEndpoint::class, '__construct', 'serviceToken'],
            [NatsSettings::class, '__construct', 'token'],
            [NatsEndpoint::class, '__construct', 'password'],
            [EnvironmentInput::class, '__construct', 'serviceToken'],
            [EnvironmentInput::class, '__construct', 'natsToken'],
        ];

        foreach ($expected as [$class, $method, $name]) {
            $parameter = collect((new ReflectionClass($class))->getMethod($method)->getParameters())->first(fn (ReflectionParameter $p): bool => $p->getName() === $name);

            $this->assertNotNull($parameter, "{$class}::{$method}(\${$name}) exists");
            $this->assertNotEmpty($parameter->getAttributes(SensitiveParameter::class), "{$class}::{$method}(\${$name}) is marked #[SensitiveParameter]");
        }
    }

    /**
     * @return array{0: string, 1: string} The exception's string trace and the plain-text arguments found in the frames of
     *                                     OUR code (objects are not opened: a SensitiveParameterValue must stay opaque).
     *                                     The HTTP client's own frames hold the request body; that is outside what a
     *                                     parameter attribute in this application can change.
     */
    private function traceOf(callable $throwing): array
    {
        $previous = ini_get('zend.exception_ignore_args');
        ini_set('zend.exception_ignore_args', '0');

        try {
            $throwing();
        } catch (Throwable $exception) {
            $arguments = [];

            foreach ($exception->getTrace() as $frame) {
                if (str_starts_with((string) ($frame['class'] ?? ''), 'App\\')) {
                    $this->collectStrings($frame['args'] ?? [], $arguments, 0);
                }
            }

            return [$exception->getTraceAsString(), implode("\n", $arguments)];
        } finally {
            ini_set('zend.exception_ignore_args', $previous === false ? '0' : $previous);
        }

        $this->fail('The call was expected to throw.');
    }

    /**
     * @param  array<array-key, mixed>  $values
     * @param  list<string>  $into
     */
    private function collectStrings(array $values, array &$into, int $depth): void
    {
        foreach ($values as $value) {
            if (is_string($value)) {
                $into[] = $value;
            } elseif (is_array($value) && $depth < 4) {
                $this->collectStrings($value, $into, $depth + 1);
            }
        }
    }

    private function endpoint(): PizzasysEndpoint
    {
        return new PizzasysEndpoint('production', PizzasysMock::BASE_URL, '/api/v1', PizzasysMock::SERVICE_NAME, self::SECRET);
    }

    /** The HTTP layer blows up in the middle of a call (not a connection error, so nothing swallows it). */
    private function httpBlowsUp(): void
    {
        Http::fake(fn (Request $request) => throw new RuntimeException('boom'));
    }

    public function test_a_password_is_not_in_the_trace_of_a_failing_login(): void
    {
        $this->httpBlowsUp();

        [$string, $dump] = $this->traceOf(fn () => app(PizzasysClient::class)->login($this->endpoint(), 'a@b.test', self::SECRET));
        $this->assertStringNotContainsString(self::SECRET, $string);
        $this->assertStringNotContainsString(self::SECRET, $dump);

        [$string, $dump] = $this->traceOf(fn () => app(PortalGateway::class)->login($this->endpoint(), 'a@b.test', self::SECRET));
        $this->assertStringNotContainsString(self::SECRET, $string);
        $this->assertStringNotContainsString(self::SECRET, $dump);
    }

    public function test_an_upstream_token_and_the_service_token_are_not_in_the_trace_of_a_failing_verify(): void
    {
        $this->httpBlowsUp();

        [$string, $dump] = $this->traceOf(fn () => app(PizzasysClient::class)->verify($this->endpoint(), self::SECRET));

        $this->assertStringNotContainsString(self::SECRET, $string);
        $this->assertStringNotContainsString(self::SECRET, $dump);
    }

    public function test_credentials_of_a_mobile_login_are_not_in_the_trace(): void
    {
        $this->usePortalMode();
        $this->httpBlowsUp();

        [$string, $dump] = $this->traceOf(fn () => app(AuthDriver::class)->attemptForApi(['email' => 'a@b.test', 'password' => self::SECRET], 'phone'));

        $this->assertStringNotContainsString(self::SECRET, $string);
        $this->assertStringNotContainsString(self::SECRET, $dump);
    }

    public function test_a_nats_token_is_not_in_the_trace_of_a_failing_connection_test(): void
    {
        $this->app->instance(NatsProbe::class, new class extends NatsProbe
        {
            public function probe(string $url, #[SensitiveParameter] ?string $token, bool $verifyTls = true, ?string $caFile = null): array
            {
                throw new RuntimeException('probe failed');
            }
        });
        Http::fake(fn () => Http::response(PizzasysMock::fixture('token-verify-inactive'), 200));

        [$string, $dump] = $this->traceOf(fn () => app(TestPortalConnection::class)($this->endpoint(), 'nats://nats.example.test:4222', self::SECRET));

        $this->assertStringNotContainsString(self::SECRET, $string);
        $this->assertStringNotContainsString(self::SECRET, $dump);
    }
}
