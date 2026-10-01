import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_THEME } from '@/embed/config/panel-config';
import {
    luminance,
    palette,
    resolveScheme,
    themeVars,
} from '@/embed/config/theme';

describe('theme', () => {
    it('measures luminance', () => {
        expect(luminance('#ffffff')).toBeCloseTo(1);
        expect(luminance('#000000')).toBeCloseTo(0);
        expect(luminance('#fff')).toBeCloseTo(1);
        expect(luminance('#0f172a')).toBeLessThan(0.05);
        expect(luminance('nonsense')).toBe(0.5);
    });

    it('resolves the scheme from the mode and the OS preference', () => {
        expect(resolveScheme('auto', true)).toBe('dark');
        expect(resolveScheme('auto', false)).toBe('light');
        expect(resolveScheme('light', true)).toBe('light');
        expect(resolveScheme('dark', false)).toBe('dark');
    });

    it('uses the admin palette in its own scheme, the shared dark palette for a light palette in dark, and swaps a dark palette in light', () => {
        const light = { surface: '#ffffff', text: '#0f172a' };
        const dark = { surface: '#111827', text: '#f9fafb' };

        expect(palette(light, 'light')).toEqual(light);
        expect(palette(light, 'dark')).toEqual({
            surface: '#1f2937',
            text: '#f3f4f6',
        });
        expect(palette(dark, 'dark')).toEqual(dark);
        expect(palette(dark, 'light')).toEqual({
            surface: '#f9fafb',
            text: '#111827',
        });
    });

    it('turns the theme into custom properties (and nothing else)', () => {
        expect(
            themeVars(
                {
                    ...DEFAULT_THEME,
                    radius: 8,
                    shadow: 'none',
                    panelWidth: 420,
                },
                'light',
            ),
        ).toEqual({
            '--pne-primary': '#0f766e',
            '--pne-on-primary': '#ffffff',
            '--pne-accent': '#f59e0b',
            '--pne-surface': '#ffffff',
            '--pne-text': '#0f172a',
            '--pne-radius': '8px',
            '--pne-font': 'Inter, system-ui, sans-serif, system-ui, sans-serif',
            '--pne-shadow': 'none',
            '--pne-panel-w': '420px',
        });
        expect(themeVars(DEFAULT_THEME, 'dark')['--pne-surface']).toBe(
            '#1f2937',
        );
    });
});
