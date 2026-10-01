/**
 * Theme -> CSS custom properties on the panel root. Only validated values (`sanitizeTheme`) reach the DOM, and only through
 * `style.setProperty`; `embed.css` derives every tint (borders, bubbles, muted text) from these with `color-mix`, so a custom
 * palette gets a coherent light and dark variant without per-colour configuration.
 */
import type {
    PanelConfig,
    PanelTheme,
    Scheme,
    ThemeMode,
} from '@/embed/config/panel-config';

/** The same dark palette the loader paints behind the panel frame, so the iframe never shows a seam. */
const DARK = { surface: '#1f2937', text: '#f3f4f6' };

const SHADOWS: Record<PanelTheme['shadow'], string> = {
    none: 'none',
    soft: '0 8px 30px rgb(15 23 42 / 0.16)',
    strong: '0 16px 48px rgb(15 23 42 / 0.32)',
};

function expand(hex: string): [number, number, number] | null {
    let digits = hex.slice(1);

    if (digits.length === 3 || digits.length === 4) {
        digits = digits
            .split('')
            .map((d) => d + d)
            .join('');
    }

    if (digits.length < 6) {
        return null;
    }

    const value = Number.parseInt(digits.slice(0, 6), 16);

    return Number.isNaN(value)
        ? null
        : [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG relative luminance (0 = black, 1 = white); mid-grey for an unreadable value. */
export function luminance(hex: string): number {
    const rgb = expand(hex);

    if (rgb === null) {
        return 0.5;
    }

    const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;

        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function resolveScheme(mode: ThemeMode, prefersDark: boolean): Scheme {
    return mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
}

/**
 * The surface/text pair for a scheme. The admin's palette is used as is when it already is that scheme. A light palette viewed in
 * dark mode gets the shared dark palette (the loader paints the same one behind the frame); a dark palette viewed in light mode
 * swaps its two colours.
 */
export function palette(
    theme: Pick<PanelTheme, 'surface' | 'text'>,
    scheme: Scheme,
): { surface: string; text: string } {
    const configuredLight = luminance(theme.surface) > 0.5;

    if (scheme === 'light') {
        return configuredLight
            ? { surface: theme.surface, text: theme.text }
            : { surface: theme.text, text: theme.surface };
    }

    return configuredLight
        ? DARK
        : { surface: theme.surface, text: theme.text };
}

export function themeVars(
    theme: PanelTheme,
    scheme: Scheme,
): Record<string, string> {
    const { surface, text } = palette(theme, scheme);

    return {
        '--pne-primary': theme.primary,
        '--pne-on-primary': theme.primaryText,
        '--pne-accent': theme.accent,
        '--pne-surface': surface,
        '--pne-text': text,
        '--pne-radius': `${theme.radius}px`,
        '--pne-font': `${theme.fontFamily}, system-ui, sans-serif`,
        '--pne-shadow': SHADOWS[theme.shadow],
        '--pne-panel-w': `${theme.panelWidth}px`,
    };
}

export function rootStyle(
    config: PanelConfig,
    scheme: Scheme,
): Record<string, string> {
    return themeVars(config.theme, scheme);
}
