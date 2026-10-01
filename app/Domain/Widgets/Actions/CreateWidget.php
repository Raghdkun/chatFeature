<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Support\WidgetKeyGenerator;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Creates a disabled widget with the default config (published = draft = defaults), a fresh public key and no identity secret.
 */
final class CreateWidget
{
    private const KEY_ATTEMPTS = 5;

    public function __construct(private readonly AuditLogger $audit) {}

    public function handle(string $name, ?User $actor = null): Widget
    {
        $config = (new WidgetConfigData)->toArray();

        for ($attempt = 1; ; $attempt++) {
            $widget = new Widget(['name' => $name]);
            $widget->forceFill([
                'public_key' => WidgetKeyGenerator::generate(),
                'config' => $config,
                'draft_config' => $config,
                'config_version' => 1,
            ]);

            try {
                $widget->save();

                break;
            } catch (UniqueConstraintViolationException $exception) {
                // A key collision is astronomically unlikely, but retrying costs nothing.
                if ($attempt >= self::KEY_ATTEMPTS) {
                    throw $exception;
                }
            }
        }

        $this->audit->record('widget.created', $widget, ['name' => $name, 'public_key' => $widget->public_key], $actor);

        return $widget->refresh();
    }
}
