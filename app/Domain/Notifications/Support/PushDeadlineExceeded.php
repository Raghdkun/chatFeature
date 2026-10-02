<?php

namespace App\Domain\Notifications\Support;

use Psr\Http\Client\ClientExceptionInterface;
use RuntimeException;

/** Not an HTTP failure: the time budget of a batch of pushes ran out before this request could start. The Web Push library reports it as "no answer" (a retryable result). */
final class PushDeadlineExceeded extends RuntimeException implements ClientExceptionInterface {}
