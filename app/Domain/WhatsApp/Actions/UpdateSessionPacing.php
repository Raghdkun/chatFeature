<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;

/**
 * The pacing overrides of one session (`settings.send_min_interval_ms`, `settings.daily_send_cap`): a value replaces the global
 * `whatsapp.*` setting for this session, `null` removes the override. Keys that are not given stay as they are.
 */
final class UpdateSessionPacing
{
    private const KEYS = ['send_min_interval_ms', 'daily_send_cap'];

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  array<string, int|null>  $input
     */
    public function handle(WhatsAppSession $session, array $input, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);
        $settings = (array) ($session->settings ?? []);

        foreach (self::KEYS as $key) {
            if (! array_key_exists($key, $input)) {
                continue;
            }

            if ($input[$key] === null) {
                unset($settings[$key]);
            } else {
                $settings[$key] = $input[$key];
            }
        }

        $session->forceFill(['settings' => $settings === [] ? null : $settings])->save();
        $this->audit->record('whatsapp.session.pacing_updated', $session, array_intersect_key($settings, array_flip(self::KEYS)), $actor);

        return $session->refresh();
    }
}
