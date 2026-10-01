<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Validation\ValidationException;

/**
 * Validates (strictly) and stores a draft config. Visitors never see it until PublishWidget copies it over.
 */
final class SaveDraft
{
    public function __construct(
        private readonly WidgetConfigValidator $configs,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @throws ValidationException
     */
    public function handle(Widget $widget, mixed $input, ?User $actor = null): Widget
    {
        $draft = $this->configs->validate($input, 'config');

        $widget->forceFill(['draft_config' => $draft->toArray()])->save();
        $this->audit->record('widget.draft_saved', $widget, ['config_version' => $widget->config_version], $actor);

        return $widget->refresh();
    }
}
