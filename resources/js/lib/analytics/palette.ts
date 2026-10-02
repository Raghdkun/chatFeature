/**
 * Chart colours, as CSS custom properties set on the analytics root (so light and dark swap in one place and the charts are written against
 * roles). Categorical slots 1-3 of the reference data-viz palette in FIXED order (a colour follows its metric, never its rank): blue,
 * orange, aqua. Validated with the palette validator (adjacent CVD separation >= 9, normal-vision >= 26, dark steps >= 3:1 on the dark
 * surface). The light aqua is below 3:1 on a light surface, so every chart carries visible legend labels AND a table view (the relief rule).
 * The heat ramp is the one-hue sequential blue: the cell colour mixes `--heat-low` (nearest the surface) towards `--heat-high`.
 */
export const PALETTE_CLASSES = [
    '[--series-1:#2a78d6] [--series-2:#eb6834] [--series-3:#1baf7a]',
    'dark:[--series-1:#3987e5] dark:[--series-2:#d95926] dark:[--series-3:#199e70]',
    '[--heat-low:#cde2fb] [--heat-high:#104281]',
    'dark:[--heat-low:#0d366b] dark:[--heat-high:#86b6ef]',
    '[--good:#0a7a0a] [--bad:#c02f2f]',
    'dark:[--good:#3fc23f] dark:[--bad:#ec6a6a]',
].join(' ');

export const SERIES_VARS = [
    'var(--series-1)',
    'var(--series-2)',
    'var(--series-3)',
] as const;
