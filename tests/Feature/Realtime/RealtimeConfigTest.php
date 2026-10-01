<?php

namespace Tests\Feature\Realtime;

use App\Data\Chat\Events\MessageCreatedPayload;
use App\Data\Chat\MessageData;
use App\Data\Chat\MessageSenderData;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Realtime\AllowedOrigins;
use App\Domain\Install\InstallAwareConfig;
use Closure;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use Pusher\Pusher;
use Tests\Support\InstallStateFake;
use Tests\TestCase;

/**
 * The Reverb runtime configuration: origins that are not `*`, publish limits that fit a long message, the public and the internal
 * address kept apart, the broadcaster switched off (not crashing) before the install and without Reverb credentials.
 */
class RealtimeConfigTest extends TestCase
{
    /** Variables this test touches, restored afterwards. */
    private const VARIABLES = [
        'APP_ENV', 'APP_URL', 'BROADCAST_CONNECTION', 'REVERB_APP_ID', 'REVERB_APP_KEY', 'REVERB_APP_SECRET', 'REVERB_HOST', 'REVERB_PORT', 'REVERB_SCHEME',
        'REVERB_PUBLISH_HOST', 'REVERB_PUBLISH_PORT', 'REVERB_PUBLISH_SCHEME', 'REVERB_SERVER_HOST', 'REVERB_SERVER_PORT', 'REVERB_ALLOWED_ORIGINS',
        'REVERB_SCALING_ENABLED', 'REVERB_MAX_REQUEST_SIZE', 'REVERB_APP_RATE_LIMITING_ENABLED', 'REALTIME_QUEUE', 'REVERB_PUBLISH_TIMEOUT', 'REVERB_PUBLISH_CONNECT_TIMEOUT',
    ];

    /**
     * Evaluate the config files against exactly these environment variables (absent = not set at all).
     *
     * @param  array<string, string|null>  $environment
     * @param  Closure(array<string, mixed> $broadcasting, array<string, mixed> $reverb): void  $assert
     */
    private function withEnvironment(array $environment, Closure $assert): void
    {
        // `env()` reads the process environment (putenv) first, then $_ENV.
        $saved = [];

        foreach (self::VARIABLES as $name) {
            $saved[$name] = ['env' => $_ENV[$name] ?? null, 'server' => $_SERVER[$name] ?? null, 'process' => getenv($name)];
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }

        foreach ($environment as $name => $value) {
            if ($value !== null) {
                $_ENV[$name] = $_SERVER[$name] = $value;
                putenv($name.'='.$value);
            }
        }

        try {
            /** @var array<string, mixed> $broadcasting */
            $broadcasting = require config_path('broadcasting.php');
            /** @var array<string, mixed> $reverb */
            $reverb = require config_path('reverb.php');

            $assert($broadcasting, $reverb);
        } finally {
            foreach ($saved as $name => $previous) {
                unset($_ENV[$name], $_SERVER[$name]);
                putenv($name);

                if ($previous['env'] !== null) {
                    $_ENV[$name] = $previous['env'];
                }

                if ($previous['server'] !== null) {
                    $_SERVER[$name] = $previous['server'];
                }

                if ($previous['process'] !== false) {
                    putenv($name.'='.$previous['process']);
                }
            }
        }
    }

    /** @return array<string, string> */
    private function reverbEnvironment(): array
    {
        return ['BROADCAST_CONNECTION' => 'reverb', 'REVERB_APP_ID' => '1', 'REVERB_APP_KEY' => 'k', 'REVERB_APP_SECRET' => 's', 'REVERB_HOST' => 'chat.example.com', 'REVERB_PORT' => '443', 'REVERB_SCHEME' => 'https', 'APP_URL' => 'https://chat.example.com'];
    }

    // ---- allowed origins ---------------------------------------------------------------------------------------------------

    public function test_origins_default_to_the_app_host_and_never_to_everything(): void
    {
        $this->withEnvironment($this->reverbEnvironment(), function (array $broadcasting, array $reverb): void {
            $this->assertSame(['chat.example.com'], $reverb['apps']['apps'][0]['allowed_origins']);
        });
    }

    public function test_extra_origins_are_added_as_bare_hosts(): void
    {
        $this->withEnvironment([...$this->reverbEnvironment(), 'REVERB_ALLOWED_ORIGINS' => ' https://Admin.Example.com:8443/x , staging.example.com:3000,, chat.example.com '], function (array $broadcasting, array $reverb): void {
            $this->assertSame(['chat.example.com', 'admin.example.com', 'staging.example.com'], $reverb['apps']['apps'][0]['allowed_origins']);
        });
    }

    public function test_a_wildcard_entry_cannot_open_everything_up(): void
    {
        $this->withEnvironment([...$this->reverbEnvironment(), 'REVERB_ALLOWED_ORIGINS' => '*, ,*.*, .'], function (array $broadcasting, array $reverb): void {
            $this->assertSame(['chat.example.com'], $reverb['apps']['apps'][0]['allowed_origins']);
            $this->assertNotContains('*', $reverb['apps']['apps'][0]['allowed_origins']);
        });
    }

    public function test_without_any_app_url_nothing_is_allowed_rather_than_everything(): void
    {
        $this->withEnvironment([...$this->reverbEnvironment(), 'APP_URL' => null], function (array $broadcasting, array $reverb): void {
            $this->assertSame([], $reverb['apps']['apps'][0]['allowed_origins']);
        });
    }

    public function test_loopback_is_allowed_in_the_local_environment_only(): void
    {
        $this->withEnvironment([...$this->reverbEnvironment(), 'APP_ENV' => 'local', 'APP_URL' => 'http://127.0.0.1:8302'], function (array $broadcasting, array $reverb): void {
            $this->assertSame(['127.0.0.1', 'localhost'], $reverb['apps']['apps'][0]['allowed_origins']);
        });

        $this->withEnvironment([...$this->reverbEnvironment(), 'APP_ENV' => 'production'], function (array $broadcasting, array $reverb): void {
            $this->assertNotContains('localhost', $reverb['apps']['apps'][0]['allowed_origins']);
        });
    }

    /**
     * @return iterable<string, array{string, string|null}>
     */
    public static function entries(): iterable
    {
        yield 'bare host' => ['chat.example.com', 'chat.example.com'];
        yield 'upper case' => ['Chat.Example.COM', 'chat.example.com'];
        yield 'with scheme and port' => ['https://chat.example.com:8443', 'chat.example.com'];
        yield 'with a path' => ['chat.example.com/app', 'chat.example.com'];
        yield 'ipv6 loopback' => ['http://[::1]:8000', '[::1]'];
        yield 'subdomain pattern' => ['*.example.com', '*.example.com'];
        yield 'only a wildcard' => ['*', null];
        yield 'empty' => ['', null];
        yield 'dots only' => ['..', null];
    }

    #[DataProvider('entries')]
    public function test_how_an_entry_is_reduced_to_a_host(string $entry, ?string $host): void
    {
        $this->assertSame($host === null ? [] : [$host], AllowedOrigins::parse($entry));
    }

    public function test_the_saved_app_url_joins_the_origins_once(): void
    {
        $this->assertSame(['a.test', 'saved.example.com'], AllowedOrigins::withAppUrl(['a.test'], 'https://Saved.Example.com/'));
        $this->assertSame(['a.test'], AllowedOrigins::withAppUrl(['a.test'], 'https://a.test'));
        $this->assertSame(['a.test'], AllowedOrigins::withAppUrl(['a.test'], ''));
    }

    // ---- limits ------------------------------------------------------------------------------------------------------------

    public function test_a_message_of_the_maximum_length_still_fits_the_publish_limit_while_the_reverb_default_would_reject_it(): void
    {
        // The worst case: `chat.max_message_length` at its maximum (20 000), every character non-ASCII (Arabic, 6 bytes as \uXXXX
        // in JSON), one attachment with a long signed URL. Pusher JSON-encodes the payload, then the whole request again.
        $message = new MessageData(
            ulid: (string) Str::ulid(), seq: 1, conversation: (string) Str::ulid(),
            sender: new MessageSenderData(SenderType::Visitor, 'مرحبا', null),
            type: MessageType::Text, body: str_repeat('م', 20_000), attachments: [], clientMsgId: (string) Str::ulid(),
            createdAt: '2026-11-20T10:00:00.000Z', deliveredAt: null, seenAt: null,
        );
        $request = json_encode([
            'name' => 'message.created',
            'data' => json_encode((new MessageCreatedPayload($message))->toArray(), JSON_THROW_ON_ERROR),
            'channels' => ['private-conversation.'.Str::ulid()],
        ], JSON_THROW_ON_ERROR);

        $this->assertGreaterThan(10_000, strlen($request), 'Reverb\'s default limit (10 000 bytes) would drop this');
        $this->assertLessThan((int) config('reverb.servers.reverb.max_request_size') - 16_384, strlen($request), 'with room for attachments');
    }

    public function test_the_limits_and_timeouts_are_sane_by_default(): void
    {
        $this->withEnvironment($this->reverbEnvironment(), function (array $broadcasting, array $reverb): void {
            $app = $reverb['apps']['apps'][0];

            $this->assertSame(262_144, $reverb['servers']['reverb']['max_request_size']);
            $this->assertSame(10_000, $app['max_message_size'], 'what a client may send: whispers only');
            $this->assertSame('members', $app['accept_client_events_from']);
            $this->assertSame(60, $app['ping_interval']);
            $this->assertSame(30, $app['activity_timeout']);
            $this->assertTrue($app['rate_limiting']['enabled']);
            $this->assertSame(120, $app['rate_limiting']['max_attempts']);
            $this->assertFalse($app['rate_limiting']['terminate_on_limit']);
            $this->assertSame(2.0, $broadcasting['connections']['reverb']['client_options']['connect_timeout']);
            $this->assertSame(5.0, $broadcasting['connections']['reverb']['client_options']['timeout']);
            $this->assertNull($broadcasting['realtime']['queue']);
        });
    }

    public function test_the_environment_overrides_the_limits(): void
    {
        $this->withEnvironment([...$this->reverbEnvironment(), 'REVERB_MAX_REQUEST_SIZE' => '500000', 'REVERB_APP_RATE_LIMITING_ENABLED' => 'false', 'REALTIME_QUEUE' => 'broadcasts', 'REVERB_PUBLISH_TIMEOUT' => '8'], function (array $broadcasting, array $reverb): void {
            $this->assertSame(500_000, $reverb['servers']['reverb']['max_request_size']);
            $this->assertFalse($reverb['apps']['apps'][0]['rate_limiting']['enabled']);
            $this->assertSame('broadcasts', $broadcasting['realtime']['queue']);
            $this->assertSame(8.0, $broadcasting['connections']['reverb']['client_options']['timeout']);
        });
    }

    public function test_redis_scaling_follows_the_switch(): void
    {
        $this->withEnvironment($this->reverbEnvironment(), function (array $broadcasting, array $reverb): void {
            $this->assertFalse($reverb['servers']['reverb']['scaling']['enabled']);
        });

        $this->withEnvironment([...$this->reverbEnvironment(), 'REVERB_SCALING_ENABLED' => 'true'], function (array $broadcasting, array $reverb): void {
            $this->assertTrue($reverb['servers']['reverb']['scaling']['enabled']);
            $this->assertSame('reverb', $reverb['servers']['reverb']['scaling']['channel']);
            $this->assertArrayHasKey('host', $reverb['servers']['reverb']['scaling']['server']);
        });
    }

    // ---- public address, internal address ----------------------------------------------------------------------------------

    public function test_the_publish_address_defaults_to_the_public_one_and_can_be_pointed_inside(): void
    {
        $this->withEnvironment($this->reverbEnvironment(), function (array $broadcasting, array $reverb): void {
            $options = $broadcasting['connections']['reverb']['options'];

            $this->assertSame(['chat.example.com', 443, 'https', true], [$options['host'], $options['port'], $options['scheme'], $options['useTLS']]);
        });

        $this->withEnvironment([...$this->reverbEnvironment(), 'REVERB_PUBLISH_HOST' => 'reverb', 'REVERB_PUBLISH_PORT' => '8080', 'REVERB_PUBLISH_SCHEME' => 'http', 'REVERB_SERVER_HOST' => '0.0.0.0', 'REVERB_SERVER_PORT' => '8080'], function (array $broadcasting, array $reverb): void {
            $publish = $broadcasting['connections']['reverb']['options'];
            $client = $reverb['apps']['apps'][0]['options'];

            $this->assertSame(['reverb', 8080, 'http', false], [$publish['host'], $publish['port'], $publish['scheme'], $publish['useTLS']]);
            $this->assertSame(['chat.example.com', '443', 'https', true], [$client['host'], $client['port'], $client['scheme'], $client['useTLS']], 'clients keep the public address');
            $this->assertSame(['0.0.0.0', '8080'], [$reverb['servers']['reverb']['host'], $reverb['servers']['reverb']['port']]);
        });
    }

    public function test_the_reverb_process_listens_on_loopback_unless_told_otherwise(): void
    {
        $this->withEnvironment($this->reverbEnvironment(), function (array $broadcasting, array $reverb): void {
            $this->assertSame('127.0.0.1', $reverb['servers']['reverb']['host']);
            $this->assertSame(8080, $reverb['servers']['reverb']['port']);
        });
    }

    // ---- the broadcaster is only on when it can work -----------------------------------------------------------------------

    /**
     * @return iterable<string, array{array<string, string|null>, string}>
     */
    public static function connections(): iterable
    {
        $full = ['REVERB_APP_ID' => '1', 'REVERB_APP_KEY' => 'k', 'REVERB_APP_SECRET' => 's', 'REVERB_HOST' => 'h'];

        yield 'reverb with everything' => [['BROADCAST_CONNECTION' => 'reverb', ...$full], 'reverb'];
        yield 'reverb without a key (not set at all)' => [['BROADCAST_CONNECTION' => 'reverb', ...$full, 'REVERB_APP_KEY' => null], 'null'];
        yield 'reverb with an empty key' => [['BROADCAST_CONNECTION' => 'reverb', ...$full, 'REVERB_APP_KEY' => ''], 'null'];
        yield 'reverb without a secret' => [['BROADCAST_CONNECTION' => 'reverb', ...$full, 'REVERB_APP_SECRET' => null], 'null'];
        yield 'reverb without an app id' => [['BROADCAST_CONNECTION' => 'reverb', ...$full, 'REVERB_APP_ID' => null], 'null'];
        yield 'reverb without a host' => [['BROADCAST_CONNECTION' => 'reverb', ...$full, 'REVERB_HOST' => null], 'null'];
        yield 'nothing configured' => [[], 'null'];
        yield 'the null string' => [['BROADCAST_CONNECTION' => 'null'], 'null'];
        yield 'log stays log' => [['BROADCAST_CONNECTION' => 'log'], 'log'];
    }

    /**
     * @param  array<string, string|null>  $environment
     */
    #[DataProvider('connections')]
    public function test_reverb_is_the_default_broadcaster_only_with_its_credentials(array $environment, string $expected): void
    {
        $this->withEnvironment($environment, function (array $broadcasting) use ($expected): void {
            $this->assertSame($expected, $broadcasting['default']);
        });
    }

    public function test_without_credentials_the_connection_can_still_be_built_without_a_type_error(): void
    {
        $this->withEnvironment(['BROADCAST_CONNECTION' => 'reverb'], function (array $broadcasting): void {
            $connection = $broadcasting['connections']['reverb'];

            $this->assertSame(['', '', ''], [$connection['key'], $connection['secret'], $connection['app_id']]);
            new Pusher($connection['key'], $connection['secret'], $connection['app_id'], $connection['options']);
        });
    }

    public function test_before_the_install_the_broadcaster_is_forced_off(): void
    {
        $state = InstallStateFake::make(installed: false);
        config(['broadcasting.default' => 'reverb']);

        $this->assertTrue((new InstallAwareConfig(app('config'), $state))->apply());
        $this->assertSame('null', config('broadcasting.default'));
    }

    public function test_after_the_install_the_configured_broadcaster_takes_over(): void
    {
        $state = InstallStateFake::make(installed: true);
        config(['broadcasting.default' => 'reverb']);

        $this->assertFalse((new InstallAwareConfig(app('config'), $state))->apply());
        $this->assertSame('reverb', config('broadcasting.default'));
    }

    public function test_the_forced_drivers_of_the_install_gate_include_the_broadcaster(): void
    {
        $this->assertSame('null', config('install.forced_drivers')['broadcasting.default']);
    }

    /**
     * Artisan must work before the install and without Reverb credentials: `routes/channels.php` registers channels in the default
     * broadcaster, which used to be built with `null` arguments (a TypeError) on every command.
     *
     * @return iterable<string, array{array<string, string>}>
     */
    public static function bootEnvironments(): iterable
    {
        yield 'not installed, Reverb asked for, credentials empty' => [['APP_INSTALLED' => 'false', 'BROADCAST_CONNECTION' => 'reverb', 'REVERB_APP_KEY' => '', 'REVERB_APP_SECRET' => '', 'REVERB_APP_ID' => '', 'REVERB_HOST' => '']];
        yield 'installed, Reverb asked for, credentials empty' => [['APP_INSTALLED' => 'true', 'BROADCAST_CONNECTION' => 'reverb', 'REVERB_APP_KEY' => '', 'REVERB_APP_SECRET' => '', 'REVERB_APP_ID' => '', 'REVERB_HOST' => '']];
        yield 'installed with credentials' => [['APP_INSTALLED' => 'true', 'BROADCAST_CONNECTION' => 'reverb', 'REVERB_APP_KEY' => 'k', 'REVERB_APP_SECRET' => 's', 'REVERB_APP_ID' => '1', 'REVERB_HOST' => 'localhost']];
    }

    /**
     * @param  array<string, string>  $environment
     */
    #[DataProvider('bootEnvironments')]
    public function test_artisan_boots_in_every_install_and_credential_state(array $environment): void
    {
        $result = Process::path(base_path())
            ->env([...$environment, 'APP_ENV' => 'production', 'DB_CONNECTION' => 'sqlite', 'DB_DATABASE' => ':memory:', 'DB_URL' => '', 'CACHE_STORE' => 'array', 'SESSION_DRIVER' => 'array', 'QUEUE_CONNECTION' => 'sync'])
            ->timeout(60)
            ->run([PHP_BINARY, 'artisan', 'route:list', '--path=broadcasting/auth', '--json']);

        $this->assertTrue($result->successful(), $result->errorOutput().$result->output());

        $uris = array_column(json_decode($result->output(), true, 512, JSON_THROW_ON_ERROR), 'uri');
        $this->assertContains('broadcasting/auth', $uris);
        $this->assertContains('api/v1/public/broadcasting/auth', $uris);
    }
}
