<?php

namespace App\Http\Exceptions;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * An expected API failure with its own machine-readable code (`category_in_use`, `managed_by_auth_portal`, ...).
 * Renders the documented envelope `{ "error": { "code", "message", "details"? } }` for every caller, so the
 * generic status-to-code mapping of ApiErrorRenderer (409 => `conflict`) does not hide the specific code.
 */
final class ApiProblemException extends HttpException
{
    /**
     * @param  array<string, mixed>|null  $details  field => messages (validation), or a plain value (`already_claimed` carries `by`)
     * @param  array<string, string>  $headers
     */
    public function __construct(
        int $status,
        private readonly string $errorCode,
        string $message,
        private readonly ?array $details = null,
        array $headers = [],
    ) {
        parent::__construct($status, $message, null, $headers);
    }

    public static function conflict(string $code, string $message): self
    {
        return new self(409, $code, $message);
    }

    public static function notFound(string $code, string $message): self
    {
        return new self(404, $code, $message);
    }

    public static function unauthorized(string $code, string $message): self
    {
        return new self(401, $code, $message);
    }

    public static function forbidden(string $code, string $message): self
    {
        return new self(403, $code, $message);
    }

    public function errorCode(): string
    {
        return $this->errorCode;
    }

    public function render(Request $request): JsonResponse
    {
        $error = ['code' => $this->errorCode, 'message' => $this->getMessage()];

        if ($this->details !== null) {
            $error['details'] = $this->details;
        }

        return response()->json(['error' => $error], $this->getStatusCode(), $this->getHeaders());
    }
}
