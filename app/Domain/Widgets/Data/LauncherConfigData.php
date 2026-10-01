<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\LauncherIcon;
use App\Domain\Widgets\Enums\LauncherStyle;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.launcher`: the bubble or pill that opens the panel. */
#[TypeScript]
class LauncherConfigData extends Data
{
    public function __construct(
        public LauncherStyle $style = LauncherStyle::Bubble,
        public LauncherIcon $icon = LauncherIcon::Chat,
        public ?string $iconUrl = null,
        public string $label = 'Chat with us',
        public ?string $avatarUrl = null,
    ) {}
}
