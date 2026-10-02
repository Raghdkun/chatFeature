<?php

namespace App\Domain\Audit;

use App\Models\AuditLog;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

/**
 * Writes `audit_logs` rows. Needs the database: never call it before `run-migrations` succeeded.
 *
 * Action names are dotted (`settings.updated`, `install.completed`). Values under keys that look
 * like secrets are redacted before they reach the table.
 */
final class AuditLogger
{
    private const REDACTED = '[redacted]';

    private const SECRET_KEYS = ['password', 'secret', 'token', 'api_key', 'private_key', 'recovery_code', 'challenge'];

    /** Keys that are a secret only as a whole (`code` is a second-factor code; `error_code` is not). */
    private const SECRET_EXACT_KEYS = ['code'];

    public function __construct(private readonly AuthFactory $auth) {}

    /**
     * @param  array<string, mixed>  $changes
     */
    public function record(
        string $action,
        ?Model $subject = null,
        array $changes = [],
        ?Authenticatable $actor = null,
    ): AuditLog {
        $actor ??= $this->auth->guard()->user();
        $workspaceId = $subject?->getAttribute('workspace_id');
        $request = request();
        // Console runs (install, artisan) carry a synthetic request: only record where it came from for routed HTTP requests.
        $fromHttp = $request->route() !== null;

        return AuditLog::query()->create([
            'workspace_id' => is_int($workspaceId) ? $workspaceId : null,
            'actor_id' => $actor?->getAuthIdentifier() !== null ? (int) $actor->getAuthIdentifier() : null,
            'action' => $action,
            'subject_type' => $subject !== null ? $subject::class : null,
            'subject_id' => $subject?->getKey() !== null ? (string) $subject->getKey() : null,
            'changes' => $changes === [] ? null : $this->redact($changes),
            'ip_address' => $fromHttp ? $request->ip() : null,
            'user_agent' => $fromHttp && $request->userAgent() !== null ? Str::limit($request->userAgent(), 500, '') : null,
        ]);
    }

    /**
     * @param  array<array-key, mixed>  $values
     * @return array<array-key, mixed>
     */
    private function redact(array $values): array
    {
        foreach ($values as $key => $value) {
            if (is_string($key) && (Str::contains(Str::lower($key), self::SECRET_KEYS) || in_array(Str::lower($key), self::SECRET_EXACT_KEYS, true))) {
                $values[$key] = self::REDACTED;

                continue;
            }

            if (is_array($value)) {
                $values[$key] = $this->redact($value);
            }
        }

        return $values;
    }
}
