<?php

namespace App\Exceptions;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Throwable;

/**
 * Renders the documented API error envelope for every `api/*` request:
 * `{ "error": { "code": "snake_case", "message": "...", "details"?: { field: ["msg"] } } }`
 * (docs/contracts/rest-shapes.md). Returns null for anything outside `api/*` so the web stack is unchanged.
 */
final class ApiErrorRenderer
{
    public static function render(Throwable $exception, Request $request): ?JsonResponse
    {
        if (! $request->is('api/*')) {
            return null;
        }

        if ($exception instanceof ValidationException) {
            return self::json('validation_failed', __('The given data was invalid.'), 422, $exception->errors());
        }

        if ($exception instanceof AuthenticationException) {
            return self::json('unauthenticated', __('Authentication is required.'), 401);
        }

        if ($exception instanceof AuthorizationException) {
            return self::json('forbidden', $exception->getMessage() !== '' ? $exception->getMessage() : __('This action is not allowed.'), 403);
        }

        if ($exception instanceof ModelNotFoundException || $exception instanceof NotFoundHttpException) {
            return self::json('not_found', __('Not found.'), 404);
        }

        if ($exception instanceof TooManyRequestsHttpException) {
            return self::json('rate_limited', __('Too many requests.'), 429, null, $exception->getHeaders());
        }

        if ($exception instanceof HttpExceptionInterface) {
            $status = $exception->getStatusCode();

            return self::json(
                match ($status) {
                    400 => 'bad_request',
                    403 => 'forbidden',
                    404 => 'not_found',
                    405 => 'method_not_allowed',
                    409 => 'conflict',
                    419 => 'csrf_mismatch',
                    429 => 'rate_limited',
                    503 => 'unavailable',
                    default => 'http_error',
                },
                $exception->getMessage() !== '' ? $exception->getMessage() : __('Request failed.'),
                $status,
                null,
                $exception->getHeaders(),
            );
        }

        // Anything else is a 500: keep the documented envelope (never leak details in production).
        if (! config('app.debug')) {
            return self::json('server_error', __('Something went wrong on our side.'), 500);
        }

        return null;
    }

    /**
     * @param  array<string, array<int, string>>|null  $details
     * @param  array<string, string>  $headers
     */
    private static function json(string $code, string $message, int $status, ?array $details = null, array $headers = []): JsonResponse
    {
        $error = ['code' => $code, 'message' => $message];

        if ($details !== null) {
            $error['details'] = $details;
        }

        return response()->json(['error' => $error], $status, $headers);
    }
}
