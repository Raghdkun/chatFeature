<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\LauncherSize;
use App\Domain\Widgets\Enums\PanelPosition;
use App\Domain\Widgets\Enums\ShadowLevel;
use App\Domain\Widgets\Enums\ThemeMode;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.theme` (docs/contracts/widget-config.md). Colours are 3/6/8-digit hex, sizes are px. */
#[TypeScript]
class ThemeConfigData extends Data
{
    public function __construct(
        public ThemeMode $mode = ThemeMode::Auto,
        public string $primary = '#0f766e',
        public string $primaryText = '#ffffff',
        public string $accent = '#f59e0b',
        public string $surface = '#ffffff',
        public string $text = '#0f172a',
        public string $fontFamily = 'Inter, system-ui, sans-serif',
        public ?string $fontUrl = null,
        public int $radius = 16,
        public ShadowLevel $shadow = ShadowLevel::Soft,
        public LauncherSize $launcherSize = LauncherSize::Md,
        public int $panelWidth = 380,
        public int $panelHeight = 620,
        public PanelPosition $position = PanelPosition::BottomRight,
        public int $offsetX = 20,
        public int $offsetY = 20,
        public int $zIndex = 2147483000,
    ) {}
}
