<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;

/**
 * The connection test of Settings > WhatsApp: the SAVED address and key, `POST /api/auth/validate`. The answer is data, not an error:
 * `{ok, role, engine, canOperate}` or `{ok: false, reason, message}` (one fixed sentence per reason; the key and the address never
 * appear in it).
 */
final class TestOpenWaConnection
{
    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @return array{ok: bool, role: string|null, engine: string|null, canOperate: bool, reason: string|null, message: string|null}
     */
    public function handle(User $actor): array
    {
        Gate::forUser($actor)->authorize('manageSettings', WhatsAppSession::class);

        try {
            $ping = $this->openWa->ping();
        } catch (OpenWaRejected|OpenWaUnavailable $exception) {
            return $this->record($actor, $this->failure(OpenWaProblem::testReason($exception)));
        }

        return $this->record($actor, [
            'ok' => true,
            'role' => $ping->role,
            'engine' => $ping->engine,
            'canOperate' => $ping->canOperate(),
            'reason' => $ping->canOperate() ? null : 'insufficient_role',
            'message' => $ping->canOperate() ? null : $this->message('insufficient_role'),
        ]);
    }

    /**
     * @return array{ok: bool, role: string|null, engine: string|null, canOperate: bool, reason: string|null, message: string|null}
     */
    private function failure(string $reason): array
    {
        return ['ok' => false, 'role' => null, 'engine' => null, 'canOperate' => false, 'reason' => $reason, 'message' => $this->message($reason)];
    }

    /**
     * @param  array{ok: bool, role: string|null, engine: string|null, canOperate: bool, reason: string|null, message: string|null}  $result
     * @return array{ok: bool, role: string|null, engine: string|null, canOperate: bool, reason: string|null, message: string|null}
     */
    private function record(User $actor, array $result): array
    {
        $this->audit->record('whatsapp.settings.tested', null, ['ok' => $result['ok'], 'reason' => $result['reason']], $actor);

        return $result;
    }

    /** One fixed sentence per reason: no address, no key, no detail of what OpenWA answered. */
    private function message(string $reason): string
    {
        return match ($reason) {
            'not_configured' => __('Save the OpenWA API key first.'),
            'blocked' => __('The saved OpenWA address is not allowed (an address on a private network needs the "allow private hosts" server setting).'),
            'unreachable' => __('OpenWA could not be reached. Check that it is running and that the address is right.'),
            'unauthorized' => __('OpenWA did not accept the API key.'),
            'unexpected_response' => __('The address answered, but not like OpenWA. Check the address.'),
            'insufficient_role' => __('The API key can only read. Starting sessions and sending needs an operator or admin key.'),
            default => __('OpenWA refused the request.'),
        };
    }
}
