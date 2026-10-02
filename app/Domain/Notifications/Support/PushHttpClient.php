<?php

namespace App\Domain\Notifications\Support;

use App\Support\Network\OutboundTarget;
use GuzzleHttp\RequestOptions;
use Illuminate\Support\Facades\Http;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * The HTTP client the Web Push library sends through: Laravel's client (so `Http::fake` covers it), with
 *
 *  - redirects never followed;
 *  - the connection PINNED to the addresses the endpoint guard judged (`CURLOPT_RESOLVE`, one `host:port:address` entry per push host:
 *    the curl handler then never resolves the name a second time, so a name re-pointed at the internal network after the judgement
 *    cannot steer the request there);
 *  - a per-request timeout and an optional TOTAL deadline for everything this client sends: a request that would start after it fails at
 *    once with {@see PushDeadlineExceeded} (a retryable "no answer"), and one that starts before it is cut off when the deadline arrives.
 */
final class PushHttpClient implements ClientInterface
{
    /**
     * @param  list<string>  $resolveEntries  `host:port:address[,address]` entries ({@see OutboundTarget::curlResolveEntry()})
     * @param  float|null  $deadlineAt  Unix time (with fraction) after which no request is started
     */
    public function __construct(
        private readonly int $timeoutSeconds,
        private readonly array $resolveEntries = [],
        private readonly ?float $deadlineAt = null,
    ) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $timeout = max(1, $this->timeoutSeconds);

        if ($this->deadlineAt !== null) {
            $left = $this->deadlineAt - microtime(true);

            if ($left < 0.25) {
                throw new PushDeadlineExceeded('The deadline for this batch of pushes passed.');
            }

            $timeout = max(1, min($timeout, (int) ceil($left)));
        }

        // The options go with the REQUEST: `Http::timeout()->buildClient()` hands back a bare Guzzle client that would ignore them.
        $options = [
            RequestOptions::SYNCHRONOUS => true,
            RequestOptions::ALLOW_REDIRECTS => false,
            RequestOptions::HTTP_ERRORS => false,
            RequestOptions::TIMEOUT => $timeout,
            RequestOptions::CONNECT_TIMEOUT => min(5, $timeout),
        ];

        if ($this->resolveEntries !== [] && defined('CURLOPT_RESOLVE')) {
            $options[RequestOptions::CURL] = [CURLOPT_RESOLVE => $this->resolveEntries];
        }

        return Http::buildClient()->sendAsync($request, $options)->wait();
    }
}
