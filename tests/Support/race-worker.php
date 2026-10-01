<?php

/*
|--------------------------------------------------------------------------
| Worker process of the MySQL concurrency tests (tests/Feature/Chat/ConcurrencyMySqlTest.php)
|--------------------------------------------------------------------------
| NOT a test and not part of the application: it boots the app in a fresh PHP process against the database named in the environment,
| waits for a shared start time so that every worker hits the database at the same moment, runs one chat action and prints one line
| of JSON: {"ok":true,...} or {"error":"<api error code>"}.
|
|   php tests/Support/race-worker.php claim    <start-at> <conversation-ulid> <user-id>
|   php tests/Support/race-worker.php send     <start-at> <conversation-ulid> <user-id|0> <count> <client-msg-id|-> <label>
*/

use App\Domain\Chat\Actions\ClaimConversation;
use App\Domain\Chat\Actions\SendMessage;
use App\Domain\Chat\Enums\SenderType;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Str;

require __DIR__.'/../../vendor/autoload.php';

$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

$action = $argv[1] ?? '';
$startAt = (float) ($argv[2] ?? 0);
$arguments = array_slice($argv, 3);

$emit = static function (array $payload): void {
    fwrite(STDOUT, json_encode($payload, JSON_THROW_ON_ERROR)."\n");
};

// Everybody boots at a different speed: hold until the common start time.
while (microtime(true) < $startAt) {
    usleep(200);
}

try {
    if ($action === 'claim') {
        [$ulid, $userId] = $arguments;
        $claimed = app(ClaimConversation::class)->handle(Conversation::query()->where('ulid', $ulid)->firstOrFail(), User::query()->findOrFail((int) $userId));
        $emit(['ok' => true, 'status' => $claimed->status->value]);
    } elseif ($action === 'send') {
        [$ulid, $userId, $count, $clientMsgId, $label] = $arguments;
        $conversation = Conversation::query()->where('ulid', $ulid)->firstOrFail();
        $agent = (int) $userId > 0 ? User::query()->findOrFail((int) $userId) : null;
        $created = 0;
        $replayed = 0;

        for ($i = 1; $i <= (int) $count; $i++) {
            $sent = app(SendMessage::class)->handle(
                $conversation,
                $agent === null ? SenderType::Visitor : SenderType::Agent,
                $agent,
                "{$label} #{$i}",
                [],
                $clientMsgId === '-' ? (string) Str::ulid() : $clientMsgId,
            );
            $sent->created ? $created++ : $replayed++;
        }

        $emit(['ok' => true, 'created' => $created, 'replayed' => $replayed]);
    } else {
        $emit(['exception' => 'unknown action '.$action]);
        exit(2);
    }
} catch (ApiProblemException $exception) {
    $emit(['error' => $exception->errorCode(), 'status' => $exception->getStatusCode()]);
} catch (Throwable $exception) {
    $emit(['exception' => $exception::class, 'message' => $exception->getMessage()]);
    exit(1);
}
