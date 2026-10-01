<?php

namespace App\Domain\Settings\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Settings\SettingsRepository;
use App\Models\User;
use Illuminate\Validation\ValidationException;

/**
 * Change a setting on behalf of a user and leave an audit trail (secret values are never logged).
 */
final class UpdateSetting
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @throws ValidationException
     */
    public function __invoke(string $key, mixed $value, ?User $actor = null, ?int $workspaceId = null): void
    {
        $definition = $this->settings->registry()->require($key);
        $before = $this->settings->get($key, null, $workspaceId);

        $this->settings->set($key, $value, $workspaceId, $actor?->id);

        $this->audit->record(
            'settings.updated',
            changes: [
                $key => $definition->encrypted
                    ? ['old' => '[encrypted]', 'new' => '[encrypted]']
                    : ['old' => $before, 'new' => $this->settings->get($key, null, $workspaceId)],
            ],
            actor: $actor,
        );
    }
}
