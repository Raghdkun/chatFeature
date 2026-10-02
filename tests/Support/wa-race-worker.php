<?php

/*
|--------------------------------------------------------------------------
| Worker process of the WhatsApp MySQL concurrency tests (tests/Feature/WhatsApp/ConcurrencyMySqlTest.php)
|--------------------------------------------------------------------------
| NOT a test and not part of the application: it boots the app in a fresh PHP process against the database named in the environment, waits
| for a shared start time so that every worker hits the database at the same moment, runs one WhatsApp action and prints one line of JSON.
|
|   php tests/Support/wa-race-worker.php deliver <start-at> <session-ulid> <base64 body> [ignored]
|   php tests/Support/wa-race-worker.php reply   <start-at> <chat-ulid> <admin-id> <count> <client-msg-id|->
*/

use App\Domain\WhatsApp\Actions\ReceiveWebhookDelivery;
use App\Domain\WhatsApp\Actions\SendReply;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Queue;
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

while (microtime(true) < $startAt) {
    usleep(200);
}

try {
    if ($action === 'deliver') {
        // A third argument (the idempotency key the old header carried) is ignored: the key is read from the signed body now.
        [$ulid, $encoded] = $arguments;
        $session = WhatsAppSession::query()->where('ulid', $ulid)->firstOrFail();
        $status = app(ReceiveWebhookDelivery::class)->handle($session, (string) base64_decode($encoded));
        $emit(['ok' => true, 'status' => $status]);
    } elseif ($action === 'reply') {
        [$ulid, $adminId, $count, $clientMsgId] = $arguments;
        // The sending itself is not under test here: the replies are stored and queued.
        Queue::fake();
        $chat = WaChat::query()->where('ulid', $ulid)->firstOrFail();
        $admin = User::query()->findOrFail((int) $adminId);
        $created = 0;
        $replayed = 0;
        $capped = 0;

        for ($i = 1; $i <= (int) $count; $i++) {
            try {
                $sent = app(SendReply::class)->handle($chat, $admin, 'reply #'.$i, $clientMsgId === '-' ? (string) Str::lower((string) Str::ulid()) : $clientMsgId);
                $sent['created'] ? $created++ : $replayed++;
            } catch (ApiProblemException $exception) {
                if ($exception->errorCode() !== 'daily_cap_reached') {
                    throw $exception;
                }

                $capped++;
            }
        }

        $emit(['ok' => true, 'created' => $created, 'replayed' => $replayed, 'capped' => $capped]);
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
