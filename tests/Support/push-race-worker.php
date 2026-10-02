<?php

/*
|--------------------------------------------------------------------------
| Worker process of the push / presence MySQL concurrency tests (tests/Feature/Notifications/PushConcurrencyMySqlTest.php)
|--------------------------------------------------------------------------
| NOT a test and not part of the application: it boots the app in a fresh PHP process against the database named in the environment,
| waits for a shared start time so that every worker hits the database at the same moment, runs one action and prints one line of JSON.
|
|   php tests/Support/push-race-worker.php subscribe <start-at> <user-id> <endpoint>
|   php tests/Support/push-race-worker.php device    <start-at> <user-id> <token>
|   php tests/Support/push-race-worker.php presence  <start-at> <user-id>
*/

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Notifications\Actions\RegisterDeviceToken;
use App\Domain\Notifications\Actions\StorePushSubscription;
use App\Domain\Presence\PresenceService;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;

require __DIR__.'/../../vendor/autoload.php';

$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

$action = $argv[1] ?? '';
$startAt = (float) ($argv[2] ?? 0);
$arguments = array_slice($argv, 3);

$emit = static function (array $payload): void {
    fwrite(STDOUT, json_encode($payload, JSON_THROW_ON_ERROR)."\n");
};

while (microtime(true) < $startAt) {
    usleep(200);
}

try {
    if ($action === 'subscribe') {
        [$userId, $endpoint] = $arguments;
        [, $created] = app(StorePushSubscription::class)->handle(
            User::query()->findOrFail((int) $userId),
            ['endpoint' => $endpoint, 'p256dh' => 'p', 'auth' => 'a'],
            'race-worker',
        );
        $emit(['ok' => true, 'created' => $created]);
    } elseif ($action === 'device') {
        [$userId, $token] = $arguments;
        app(RegisterDeviceToken::class)->handle(User::query()->findOrFail((int) $userId), 'android', $token);
        $emit(['ok' => true]);
    } elseif ($action === 'presence') {
        [$userId] = $arguments;
        $presence = app(PresenceService::class)->set(User::query()->findOrFail((int) $userId), PresenceStatus::Online);
        $emit(['ok' => true, 'status' => $presence->status->value]);
    } else {
        $emit(['exception' => 'unknown action '.$action]);
        exit(2);
    }
} catch (Throwable $exception) {
    $emit(['exception' => $exception::class, 'message' => mb_substr($exception->getMessage(), 0, 300)]);
    exit(1);
}
