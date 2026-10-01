<?php

/*
 * A tiny single-client NATS + JetStream protocol stub used by BasisJetStreamGatewayTest to exercise the REAL
 * gateway (and the basis-company/nats client under it) over a real TCP socket without a NATS server.
 *
 *   php stub-nats-server.php <scenario.json> <log-file>
 *
 * It prints "PORT <n>" on stdout once listening, serves one connection, speaks just enough of the protocol
 * (INFO/CONNECT/PING, SUB/UNSUB, PUB/HPUB, $JS.API stream + consumer calls, pull requests, acks) and appends what
 * the client did to the log file: one "<KIND> <detail>" line each. It is a protocol model written from the NATS
 * docs, not the real server; tests/Feature/Nats/NatsIntegrationTest.php is the real-server check.
 *
 * scenario.json: {
 *   "token": "expected-token" | null,         // CONNECT auth_token to require (else -ERR 'Authorization Violation')
 *   "stream_exists": false,                    // STREAM.NAMES lists the stream from the start
 *   "consumer_exists": false,                  // CONSUMER.INFO succeeds from the start
 *   "messages": [{"subject": "...", "body": "..."}],   // queued for delivery
 *   "late": [{"after": 0.5, "subject": "...", "body": "..."}],  // appear this many seconds after startup
 *   "tls": {"pem": "/path/cert-and-key.pem"},  // announce tls_required in INFO and upgrade the connection (self-signed test certificate)
 *   "garbage_info": 100000,                    // instead of INFO, write this many bytes without a line end (a hostile server)
 *   "banner": "HTTP/1.1 400 Bad Request",       // instead of INFO, write this line (a server that is not NATS)
 *   "push_before_info_reply": [{"subject": "...", "body": "..."}],  // delivered on the active pull just BEFORE the next CONSUMER.INFO reply
 *   "idle_exit": 12                            // give up after this many seconds
 * }
 */

[, $scenarioFile, $logFile] = $argv;
$scenario = json_decode((string) file_get_contents($scenarioFile), true, 512, JSON_THROW_ON_ERROR);

$log = static function (string $line) use ($logFile): void {
    file_put_contents($logFile, $line."\n", FILE_APPEND | LOCK_EX);
};

$serverContext = isset($scenario['tls']['pem']) ? stream_context_create(['ssl' => ['local_cert' => $scenario['tls']['pem'], 'verify_peer' => false]]) : null;
$server = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $serverContext);
if ($server === false) {
    fwrite(STDERR, "cannot listen: {$errorMessage}\n");
    exit(1);
}

$port = explode(':', (string) stream_socket_get_name($server, false))[1];
fwrite(STDOUT, "PORT {$port}\n");
fflush(STDOUT);

$client = @stream_socket_accept($server, 15);
if ($client === false) {
    exit(1);
}

$info = ['server_id' => 'STUB', 'server_name' => 'stub', 'version' => '2.11.0', 'proto' => 1, 'headers' => true, 'max_payload' => 1048576, 'jetstream' => true, 'auth_required' => $scenario['token'] !== null];

// Hostile or foreign servers, for the probe tests: something other than a normal INFO line.
if (isset($scenario['garbage_info']) || isset($scenario['banner'])) {
    $payload = isset($scenario['banner']) ? $scenario['banner']."\r\n" : str_repeat('A', (int) $scenario['garbage_info']);
    $offset = 0;
    stream_set_blocking($client, false);
    $until = microtime(true) + 3;
    while ($offset < strlen($payload) && microtime(true) < $until) {
        $written = @fwrite($client, substr($payload, $offset));
        $offset += is_int($written) ? $written : 0;
        usleep(1000);
    }
    $log('SENT '.$offset);
    sleep(1);
    exit(0);
}

if (isset($scenario['tls']['pem'])) {
    // INFO goes out in clear (that is how NATS announces TLS), then the client upgrades the connection.
    $info['tls_required'] = true;
    fwrite($client, 'INFO '.json_encode($info)."\r\n");

    if (@stream_socket_enable_crypto($client, true, STREAM_CRYPTO_METHOD_TLS_SERVER) !== true) {
        $log('TLS_FAILED');
        exit(0);
    }

    $log('TLS_OK');
}

stream_set_blocking($client, false);

$started = microtime(true);
$buffer = '';
$subscriptions = [];          // subject => sid
$streams = ($scenario['stream_exists'] ?? false) ? ['AUTH_EVENTS'] : [];
$consumers = ($scenario['consumer_exists'] ?? false) ? ['*'] : [];
$queue = [];                  // list of ['seq' => int, 'subject' => string, 'body' => string, 'deliveries' => int]
$inflight = [];               // seq => message
$pulls = [];                  // list of ['subject' => inbox, 'batch' => int, 'sent' => int, 'expires_at' => float, 'stream' => string, 'durable' => string]
$late = $scenario['late'] ?? [];
$nextSeq = 1;

foreach ($scenario['messages'] ?? [] as $message) {
    $queue[] = ['seq' => $nextSeq++, 'subject' => $message['subject'], 'body' => $message['body'], 'deliveries' => 0];
}

$send = static function (string $data) use ($client): void {
    $offset = 0;
    while ($offset < strlen($data)) {
        $written = @fwrite($client, substr($data, $offset));
        if ($written === false || $written === 0) {
            usleep(1000);

            continue;
        }
        $offset += $written;
    }
};

$matches = static function (string $pattern, string $subject): bool {
    $p = explode('.', $pattern);
    $s = explode('.', $subject);
    foreach ($p as $i => $token) {
        if ($token === '>') {
            return count($s) > $i;
        }
        if (! isset($s[$i]) || ($token !== '*' && $token !== $s[$i])) {
            return false;
        }
    }

    return count($p) === count($s);
};

$respond = function (string $replySubject, array $payload) use (&$subscriptions, $send, $matches): void {
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES);
    foreach ($subscriptions as $pattern => $sid) {
        if ($matches($pattern, $replySubject)) {
            $send("MSG {$replySubject} {$sid} ".strlen($body)."\r\n{$body}\r\n");

            return;
        }
    }
};

$apiError = static fn (int $code, int $errCode, string $description): array => ['type' => 'io.nats.jetstream.api.v1.error', 'error' => ['code' => $code, 'err_code' => $errCode, 'description' => $description]];

if (! isset($scenario['tls']['pem'])) {
    $send('INFO '.json_encode($info)."\r\n");
}

$deliver = function () use (&$queue, &$inflight, &$pulls, &$subscriptions, $send): void {
    foreach ($pulls as $index => &$pull) {
        while ($pull['sent'] < $pull['batch'] && $queue !== []) {
            $message = array_shift($queue);
            $message['deliveries']++;
            $inflight[$message['seq']] = $message;
            $ackSubject = '$JS.ACK._.ACCHASH.'.$pull['stream'].'.'.$pull['durable'].'.'.$message['deliveries'].'.'.$message['seq'].'.'.$message['seq'].'.1759320000000000000.0.rnd';
            $sid = $subscriptions[$pull['subject']] ?? null;
            if ($sid === null) {
                continue 2;
            }
            $send("MSG {$message['subject']} {$sid} {$ackSubject} ".strlen($message['body'])."\r\n{$message['body']}\r\n");
            $pull['sent']++;
        }

        if ($pull['sent'] >= $pull['batch']) {
            unset($pulls[$index]);

            continue;
        }

        if (microtime(true) >= $pull['expires_at']) {
            $sid = $subscriptions[$pull['subject']] ?? null;
            if ($sid !== null) {
                $headers = "NATS/1.0 408 Request Timeout\r\n\r\n";
                $send("HMSG {$pull['subject']} {$sid} ".strlen($headers).' '.strlen($headers)."\r\n{$headers}\r\n");
            }
            unset($pulls[$index]);
        }
    }
};

$pushBeforeInfoReply = $scenario['push_before_info_reply'] ?? [];

$handleFrame = function (string $command, string $payload) use (&$streams, &$consumers, &$queue, &$inflight, &$pulls, &$subscriptions, &$nextSeq, &$pushBeforeInfoReply, $scenario, $log, $send, $respond, $apiError, $deliver): void {
    $parts = explode(' ', $command);
    $verb = $parts[0];

    if ($verb === 'CONNECT') {
        $connect = json_decode(substr($command, 8), true) ?: [];
        $log('CONNECT headers='.(($connect['headers'] ?? false) ? '1' : '0').' token='.($connect['auth_token'] ?? '-'));
        if ($scenario['token'] !== null && ($connect['auth_token'] ?? null) !== $scenario['token']) {
            $send("-ERR 'Authorization Violation'\r\n");
        }

        return;
    }

    if ($verb === 'PING') {
        $send("PONG\r\n");

        return;
    }

    if ($verb === 'PONG') {
        return;
    }

    if ($verb === 'SUB') {
        $subscriptions[$parts[1]] = end($parts);
        $log('SUB '.$parts[1]);

        return;
    }

    if ($verb === 'UNSUB') {
        $log('UNSUB '.$parts[1]);

        return;
    }

    if ($verb !== 'PUB' && $verb !== 'HPUB') {
        return;
    }

    $subject = $parts[1];
    $reply = count($parts) === ($verb === 'PUB' ? 4 : 5) ? $parts[2] : null;

    if (str_starts_with($subject, '$JS.ACK.')) {
        $tokens = explode('.', $subject);
        $seq = (int) $tokens[7];
        if (str_starts_with($payload, '-NAK')) {
            $log('NAK '.$seq.' '.trim(substr($payload, 4)));
            if (isset($inflight[$seq])) {
                $queue[] = $inflight[$seq];
                unset($inflight[$seq]);
            }
        } elseif (str_starts_with($payload, '+TERM')) {
            $log('TERM '.$seq);
            unset($inflight[$seq]);
        } else {
            $log('ACK '.$seq.' deliveries='.($tokens[6] ?? '?'));
            unset($inflight[$seq]);
        }

        return;
    }

    if (str_starts_with($subject, '$JS.API.CONSUMER.MSG.NEXT.')) {
        [, , , , , $stream, $durable] = explode('.', $subject);
        $request = json_decode($payload, true) ?: [];
        $log('PULL batch='.($request['batch'] ?? '?').' expires='.($request['expires'] ?? '?'));
        $pulls[] = ['subject' => (string) $reply, 'batch' => (int) ($request['batch'] ?? 1), 'sent' => 0, 'expires_at' => microtime(true) + ($request['expires'] ?? 1_000_000_000) / 1e9, 'stream' => $stream, 'durable' => $durable];

        return;
    }

    if (! str_starts_with($subject, '$JS.API.') || $reply === null) {
        return;
    }

    $api = substr($subject, strlen('$JS.API.'));
    $log('API '.$api);

    if ($api === 'STREAM.NAMES') {
        $respond($reply, ['type' => 'io.nats.jetstream.api.v1.stream_names_response', 'total' => count($streams), 'offset' => 0, 'limit' => 1024, 'streams' => $streams === [] ? null : $streams]);
    } elseif (str_starts_with($api, 'STREAM.CREATE.')) {
        $log('STREAM_CONFIG '.$payload);
        $streams[] = substr($api, strlen('STREAM.CREATE.'));
        $respond($reply, ['type' => 'io.nats.jetstream.api.v1.stream_create_response', 'config' => json_decode($payload, true), 'created' => '2026-10-01T00:00:00Z']);
    } elseif (str_starts_with($api, 'CONSUMER.INFO.')) {
        if ($pushBeforeInfoReply !== [] && $pulls !== []) {
            $next = array_shift($pushBeforeInfoReply);
            $queue[] = ['seq' => $nextSeq++, 'subject' => $next['subject'], 'body' => $next['body'], 'deliveries' => 0];
            $deliver();
        }

        if ($consumers === []) {
            $respond($reply, $apiError(404, 10014, 'consumer not found'));
        } else {
            $respond($reply, ['type' => 'io.nats.jetstream.api.v1.consumer_info_response', 'stream_name' => 'AUTH_EVENTS', 'name' => 'x', 'config' => []]);
        }
    } elseif (str_starts_with($api, 'CONSUMER.DURABLE.CREATE.')) {
        $log('CONSUMER_CONFIG '.$payload);
        $consumers[] = $api;
        $respond($reply, ['type' => 'io.nats.jetstream.api.v1.consumer_create_response', 'stream_name' => 'AUTH_EVENTS', 'name' => 'x', 'config' => []]);
    } else {
        $respond($reply, $apiError(404, 10003, 'unsupported in stub'));
    }
};

while (true) {
    $read = [$client];
    $write = $except = null;
    $ready = @stream_select($read, $write, $except, 0, 20_000);

    if ($ready) {
        $chunk = fread($client, 65536);
        if ($chunk === '' || $chunk === false) {
            if (feof($client)) {
                break;
            }
        } else {
            $buffer .= $chunk;
        }
    }

    while (($end = strpos($buffer, "\r\n")) !== false) {
        $command = substr($buffer, 0, $end);
        $verb = strtok($command, ' ');
        $payload = '';

        if ($verb === 'PUB' || $verb === 'HPUB') {
            $parts = explode(' ', $command);
            $length = (int) end($parts);
            if (strlen($buffer) < $end + 2 + $length + 2) {
                break;
            }
            $payload = substr($buffer, $end + 2, $length);
            if ($verb === 'HPUB') {
                $headerLength = (int) $parts[count($parts) - 2];
                $payload = substr($payload, $headerLength);
            }
            $buffer = substr($buffer, $end + 2 + $length + 2);
        } else {
            $buffer = substr($buffer, $end + 2);
        }

        $handleFrame($command, $payload);
    }

    foreach ($late as $i => $entry) {
        if (microtime(true) - $started >= $entry['after']) {
            $queue[] = ['seq' => $nextSeq++, 'subject' => $entry['subject'], 'body' => $entry['body'], 'deliveries' => 0];
            unset($late[$i]);
        }
    }

    $deliver();

    if (microtime(true) - $started > ($scenario['idle_exit'] ?? 15)) {
        break;
    }
}
