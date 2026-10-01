import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBoot, resolve, sanitizeOverrides } from '../src/config';
import {
    ALERT_MS,
    FADE_MS,
    FLIP_IN_MS,
    FLIP_OUT_MS,
    POPUP_EXIT_MS,
    SIZES,
    Ui,
} from '../src/launcher';
import type { UiHandlers } from '../src/launcher';
import type { Greeting } from '../src/types';
import { KEY, makeBootCfg, resetGlobals } from './helpers';

type Dict = Record<string, unknown>;

const greeting = (over: Partial<Greeting> = {}): Greeting => ({
    id: 'g1',
    body: 'Hi there, need help?',
    agentName: 'Sara Connor',
    agentAvatarUrl: 'https://cdn.example.com/sara.png',
    locale: null,
    weight: 1,
    ...over,
});

const eff = (cfg: Dict = {}, ov: Dict = {}) => {
    const boot = parseBoot(makeBootCfg(cfg), KEY);

    if (boot === null) {
        throw new Error('bad fixture');
    }

    return resolve(
        boot,
        sanitizeOverrides(ov, { base: 'https://host.example/' }),
        ['en'],
    );
};

describe('Ui (launcher, popup, panel frame)', () => {
    let handlers: { [K in keyof UiHandlers]: ReturnType<typeof vi.fn> };
    let ui: Ui;

    const mount = (cfg: Dict = {}, ov: Dict = {}, dark = false): Ui => {
        handlers = {
            toggle: vi.fn(),
            greetingClick: vi.fn(),
            greetingDismiss: vi.fn(),
            escape: vi.fn(),
            gesture: vi.fn(),
        };
        ui = new Ui(handlers as unknown as UiHandlers);
        ui.apply(eff(cfg, ov), dark);
        ui.mount(document.body);

        return ui;
    };
    const q = <T extends Element = HTMLElement>(sel: string): T =>
        ui.shadow.querySelector(sel) as T;
    const showFace = (over: Dict = {}) =>
        ui.showGreeting(greeting(), {
            avatar: 'https://cdn.example.com/sara.png',
            name: 'Sara Connor',
            flip: true,
            dismissLabel: 'Dismiss',
            ...over,
        });

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        ui?.destroy();
        vi.useRealTimers();
        resetGlobals();
    });

    describe('structure and isolation', () => {
        it('lives in an open shadow root on a single host element', () => {
            mount();
            const hosts = document.body.querySelectorAll('pne-chat-widget');
            expect(hosts).toHaveLength(1);
            expect(hosts[0].shadowRoot).not.toBeNull();
            expect(hosts[0].shadowRoot?.mode).toBe('open');
            // nothing of the widget leaks into the light DOM
            expect(hosts[0].children).toHaveLength(0);
            expect(document.body.querySelector('.launcher')).toBeNull();
        });

        it('pins the host with !important and resets inherited styles', () => {
            mount();
            const s = ui.host.style;
            expect(s.getPropertyValue('all')).toBe('initial');
            expect(s.getPropertyPriority('all')).toBe('important');
            expect(s.getPropertyValue('position')).toBe('fixed');
            expect(s.getPropertyPriority('position')).toBe('important');
            expect(s.getPropertyValue('width')).toMatch(/^0(px)?$/);
        });

        it('ships its stylesheet inside the shadow root (adopted or <style>), never into document.head', () => {
            mount();
            const styled =
                ui.shadow.adoptedStyleSheets?.length > 0 ||
                (ui.shadow.querySelector('style')?.textContent ?? '').includes(
                    '.launcher',
                );
            expect(styled).toBe(true);
            expect(document.head.querySelector('style')).toBeNull();
        });

        it('removes everything on destroy', () => {
            mount({
                theme: { fontUrl: 'https://fonts.bunny.net/css?family=inter' },
            });
            expect(
                document.head.querySelector('link[data-pne-chat-font]'),
            ).not.toBeNull();
            ui.destroy();
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            expect(
                document.head.querySelector('link[data-pne-chat-font]'),
            ).toBeNull();
        });
    });

    describe('theming', () => {
        it('applies config as CSS custom properties and data attributes', () => {
            mount({
                theme: {
                    primary: '#112233',
                    primaryText: '#fefefe',
                    radius: 10,
                    launcherSize: 'lg',
                    offsetX: 7,
                    offsetY: 9,
                    zIndex: 4242,
                    position: 'bottom-left',
                    panelWidth: 400,
                    panelHeight: 500,
                    shadow: 'none',
                },
            });
            const v = (k: string) => q('.root').style.getPropertyValue(k);
            expect(v('--primary')).toBe('#112233');
            expect(v('--primary-text')).toBe('#fefefe');
            expect(v('--radius')).toBe('10px');
            expect(v('--size')).toBe(`${SIZES.lg}px`);
            expect(v('--ox')).toBe('7px');
            expect(v('--oy')).toBe('9px');
            expect(v('--pw')).toBe('400px');
            expect(v('--ph')).toBe('500px');
            expect(v('--shadow')).toBe('none');
            expect(ui.host.style.getPropertyValue('z-index')).toBe('4242');
            expect(q('.root').dataset.pos).toBe('bottom-left');
        });

        it('swaps surface and text for the dark scheme and back', () => {
            mount({ theme: { surface: '#fafafa', text: '#101010' } });
            const v = (k: string) => q('.root').style.getPropertyValue(k);
            expect(v('--surface')).toBe('#fafafa');
            ui.setScheme(true);
            expect(q('.root').dataset.scheme).toBe('dark');
            expect(v('--surface')).not.toBe('#fafafa');
            expect(v('--text')).not.toBe('#101010');
            ui.setScheme(false);
            expect(v('--surface')).toBe('#fafafa');
        });

        it('picks a readable badge text colour for any accent', () => {
            mount({ theme: { accent: '#fde047' } });
            expect(q('.root').style.getPropertyValue('--accent-text')).toBe(
                '#0f172a',
            );
            ui.apply(eff({ theme: { accent: '#1e3a8a' } }), false);
            expect(q('.root').style.getPropertyValue('--accent-text')).toBe(
                '#ffffff',
            );
        });

        it('is RTL aware through dir without touching the physical corner', () => {
            mount({}, { locale: 'ar', theme: { position: 'bottom-right' } });
            expect(q('.root').getAttribute('dir')).toBe('rtl');
            expect(q('.root').dataset.pos).toBe('bottom-right');
        });

        it('loads only allow-listed font stylesheets into the document head', () => {
            mount({ theme: { fontUrl: 'https://evil.example/f.css' } });
            expect(
                document.head.querySelector('link[data-pne-chat-font]'),
            ).toBeNull();
            ui.apply(
                eff({
                    theme: {
                        fontUrl:
                            'https://fonts.googleapis.com/css2?family=Inter',
                    },
                }),
                false,
            );
            const link = document.head.querySelector<HTMLLinkElement>(
                'link[data-pne-chat-font]',
            );
            expect(link?.href).toBe(
                'https://fonts.googleapis.com/css2?family=Inter',
            );
            ui.apply(eff({ theme: { fontUrl: null } }), false);
            expect(
                document.head.querySelector('link[data-pne-chat-font]'),
            ).toBeNull();
        });
    });

    describe('launcher button', () => {
        it('is a labelled, focusable button wired to the panel', () => {
            mount({ launcher: { label: 'Talk to us' } });
            const b = q<HTMLButtonElement>('button.launcher');
            expect(b.tagName).toBe('BUTTON');
            expect(b.type).toBe('button');
            expect(b.getAttribute('aria-label')).toBe('Talk to us');
            expect(b.getAttribute('aria-expanded')).toBe('false');
            expect(b.getAttribute('aria-haspopup')).toBe('dialog');
            expect(b.tabIndex).toBeGreaterThanOrEqual(0);
            const panel = ui.shadow.getElementById(
                b.getAttribute('aria-controls') ?? '',
            );
            expect(panel).toBe(q('.panel'));
            expect(panel?.getAttribute('role')).toBe('dialog');
            expect(panel?.getAttribute('aria-label')).toBe('Support');
        });

        it('click calls toggle and the first gesture unlocks audio exactly once', () => {
            mount();
            q('button.launcher').dispatchEvent(new Event('pointerdown'));
            q('button.launcher').dispatchEvent(new Event('keydown'));
            q('button.launcher').click();
            expect(handlers.toggle).toHaveBeenCalledTimes(1);
            expect(handlers.gesture).toHaveBeenCalledTimes(1);
        });

        it('reflects the open state in aria-expanded, the label and the panel', () => {
            mount();
            ui.setOpen(true, false);
            expect(q('button.launcher').getAttribute('aria-expanded')).toBe(
                'true',
            );
            expect(q('button.launcher').getAttribute('aria-label')).toBe(
                'Close chat',
            );
            expect(q('.panel').dataset.open).toBe('true');
            expect(q('.panel').hasAttribute('inert')).toBe(false);
            ui.setOpen(false, false);
            expect(q('button.launcher').getAttribute('aria-expanded')).toBe(
                'false',
            );
            expect(q('button.launcher').getAttribute('aria-label')).toBe(
                'Chat with us',
            );
            expect(q('.panel').hasAttribute('inert')).toBe(true);
        });

        it('shows the label only for the pill style', () => {
            mount({ launcher: { style: 'bubble', label: 'Chat now' } });
            expect(q('.lbl')).toBeNull();
            ui.apply(
                eff({ launcher: { style: 'pill', label: 'Chat now' } }),
                false,
            );
            expect(q('.lbl').textContent).toBe('Chat now');
            expect(q('button.launcher').dataset.style).toBe('pill');
        });

        it.each(['chat', 'help', 'sparkle'])(
            'renders the %s icon as inline SVG',
            (icon) => {
                mount({ launcher: { icon } });
                expect(q('.front svg.ico-main path')).not.toBeNull();
                expect(q('.front svg.ico-close')).not.toBeNull();
            },
        );

        it('renders a custom icon as an <img> with a safe referrer policy', () => {
            mount({
                launcher: {
                    icon: 'custom',
                    iconUrl: 'https://cdn.example.com/i.svg',
                },
            });
            const img = q<HTMLImageElement>('.front img.ico-main');
            expect(img.src).toBe('https://cdn.example.com/i.svg');
            expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
            expect(img.alt).toBe('');
        });

        it('keeps the open label localisable through texts', () => {
            mount({
                texts: { en: { title: 'Support', closeChat: 'Schließen' } },
            });
            ui.setOpen(true, false);
            expect(q('button.launcher').getAttribute('aria-label')).toBe(
                'Schließen',
            );
        });
    });

    describe('unread badge and alert', () => {
        it('shows the count (capped at 99+) and exposes it in the accessible name', () => {
            mount();
            ui.setBadge(3);
            expect(q('.badge').textContent).toBe('3');
            expect(q('.badge').dataset.show).toBe('true');
            expect(q('button.launcher').getAttribute('aria-label')).toBe(
                'Chat with us, 3 unread messages',
            );
            ui.setBadge(250);
            expect(q('.badge').textContent).toBe('99+');
            ui.setBadge(0);
            expect(q('.badge').dataset.show).toBe('false');
            expect(q('button.launcher').getAttribute('aria-label')).toBe(
                'Chat with us',
            );
        });

        it('hides the badge while the panel is open', () => {
            mount();
            ui.setOpen(true, false);
            ui.setBadge(2);
            expect(q('.badge').dataset.show).toBe('false');
        });

        it('alert() plays for a few seconds then stops, and can be retriggered', () => {
            mount();
            ui.alert();
            expect(q('button.launcher').dataset.alert).toBe('true');
            vi.advanceTimersByTime(ALERT_MS - 1);
            expect(q('button.launcher').dataset.alert).toBe('true');
            vi.advanceTimersByTime(1);
            expect(q('button.launcher').dataset.alert).toBe('false');
            ui.alert();
            vi.advanceTimersByTime(1000);
            ui.alert();
            vi.advanceTimersByTime(ALERT_MS - 1);
            expect(q('button.launcher').dataset.alert).toBe('true');
        });
    });

    describe('greeting popup', () => {
        it('has a persistent polite live region and inserts the card into it', () => {
            mount();
            expect(q('.live').getAttribute('aria-live')).toBe('polite');
            expect(q('.live').children).toHaveLength(0);
            showFace();
            expect(q('.live .greet')).not.toBeNull();
            expect(q('.greet .g-name').textContent).toBe('Sara Connor');
            expect(q('.greet .g-body').textContent).toBe(
                'Hi there, need help?',
            );
            expect(ui.greetingVisible).toBe(true);
        });

        it('renders greeting and agent text as text, never as markup', () => {
            mount();
            const payload =
                '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
            ui.showGreeting(greeting({ body: payload }), {
                avatar: null,
                name: payload,
                flip: false,
                dismissLabel: payload,
            });
            expect(q('.greet .g-body').textContent).toBe(payload);
            expect(q('.greet .g-name').textContent).toBe(payload);
            expect(
                ui.shadow.querySelectorAll('.greet img, .greet script'),
            ).toHaveLength(0);
            expect(q('.g-x').getAttribute('aria-label')).toBe(payload);
            expect((window as unknown as Dict).__xss).toBeUndefined();
        });

        it('clicking the message opens the chat; the x dismisses', () => {
            mount();
            showFace();
            q('.g-main').click();
            expect(handlers.greetingClick).toHaveBeenCalledTimes(1);
            q('.g-x').click();
            expect(handlers.greetingDismiss).toHaveBeenCalledTimes(1);
            expect(q('.g-x').getAttribute('aria-label')).toBe('Dismiss');
        });

        it('both actions are real buttons (keyboard reachable)', () => {
            mount();
            showFace();
            expect(q('.g-main').tagName).toBe('BUTTON');
            expect(q('.g-x').tagName).toBe('BUTTON');
        });

        it('animates in (enter -> open) and out (exit, inert, removed after the exit time)', () => {
            mount();
            showFace();
            expect(q('.greet').dataset.state).toBe('open');
            ui.hideGreeting();
            expect(q('.greet').dataset.state).toBe('exit');
            expect(q('.greet').hasAttribute('inert')).toBe(true);
            expect(ui.greetingVisible).toBe(false);
            vi.advanceTimersByTime(POPUP_EXIT_MS);
            expect(q('.greet')).toBeNull();
        });

        it('replaces a visible greeting instead of stacking', () => {
            mount();
            showFace();
            ui.showGreeting(greeting({ id: 'g2', body: 'Second' }), {
                avatar: null,
                name: null,
                flip: false,
                dismissLabel: 'Dismiss',
            });
            expect(ui.shadow.querySelectorAll('.greet')).toHaveLength(1);
            expect(q('.g-body').textContent).toBe('Second');
            expect(q('.g-name')).toBeNull();
        });

        it('falls back to initials when there is no avatar, and when the image fails', () => {
            mount();
            showFace({ avatar: null });
            expect(q('.g-av .av').textContent).toBe('SC');
            showFace();
            const img = q<HTMLImageElement>('.g-av img');
            expect(img.src).toBe('https://cdn.example.com/sara.png');
            img.dispatchEvent(new Event('error'));
            expect(q('.g-av .av').tagName).toBe('SPAN');
            expect(q('.g-av .av').textContent).toBe('SC');
        });

        it('hideGreeting without an active greeting is a no-op', () => {
            mount();
            expect(() => ui.hideGreeting()).not.toThrow();
        });
    });

    describe('flip state machine', () => {
        it('front -> to-agent -> agent -> to-front -> front with the documented timings', () => {
            mount();
            expect(ui.flip).toBe('front');
            expect(q('.card').dataset.face).toBe('front');
            showFace();
            expect(ui.flip).toBe('to-agent');
            expect(q('.card').dataset.face).toBe('agent');
            vi.advanceTimersByTime(FLIP_IN_MS - 1);
            expect(ui.flip).toBe('to-agent');
            vi.advanceTimersByTime(1);
            expect(ui.flip).toBe('agent');

            ui.hideGreeting();
            expect(ui.flip).toBe('to-front');
            expect(q('.card').dataset.face).toBe('front');
            vi.advanceTimersByTime(FLIP_OUT_MS);
            expect(ui.flip).toBe('front');
            expect(q('.card').dataset.flip).toBe('front');
        });

        it('shows the agent avatar (or initials) on the back face', () => {
            mount();
            showFace();
            expect(q<HTMLImageElement>('.back img.av').src).toBe(
                'https://cdn.example.com/sara.png',
            );
            showFace({ avatar: null });
            expect(q('.back .av').textContent).toBe('SC');
        });

        it('pill launchers show the agent name next to the avatar', () => {
            mount({ launcher: { style: 'pill' } });
            showFace();
            expect(q('.back .nm').textContent).toBe('Sara Connor');
        });

        it('hiding mid-flip lands on the front face (interruptible, last call wins)', () => {
            mount();
            showFace();
            vi.advanceTimersByTime(200);
            ui.hideGreeting();
            expect(q('.card').dataset.face).toBe('front');
            vi.advanceTimersByTime(FLIP_OUT_MS + FLIP_IN_MS);
            expect(ui.flip).toBe('front');
        });

        it('does not flip when flip is off or there is no face to show', () => {
            mount();
            showFace({ flip: false });
            expect(ui.flip).toBe('front');
            showFace({ avatar: null, name: null });
            expect(ui.flip).toBe('front');
            expect(q('.card').dataset.face).toBe('front');
        });
    });

    describe('reduced motion', () => {
        it('switches to the crossfade path (no 3D flip) and uses the short duration', () => {
            mount();
            ui.setMotion(true);
            expect(q('.root').dataset.motion).toBe('reduced');
            showFace();
            expect(q('.card').dataset.face).toBe('agent'); // CSS turns this into an opacity change
            vi.advanceTimersByTime(FADE_MS - 1);
            expect(ui.flip).toBe('to-agent');
            vi.advanceTimersByTime(1);
            expect(ui.flip).toBe('agent');
        });

        it('reacts live when the preference changes while a greeting is visible', () => {
            mount();
            showFace();
            ui.setMotion(true);
            ui.hideGreeting();
            vi.advanceTimersByTime(FADE_MS);
            expect(ui.flip).toBe('front');
            ui.setMotion(false);
            expect(q('.root').dataset.motion).toBe('full');
        });

        it('the stylesheet only animates transform/opacity and has a reduced-motion branch', () => {
            // vitest stubs CSS imports, so read the source file itself
            const css = readFileSync(
                resolvePath(process.cwd(), 'resources/widget/src/styles.css'),
                'utf8',
            );

            expect(css).toContain("[data-motion='reduced']");
            expect(css).not.toMatch(/transition:\s*all/);
            expect(css).not.toMatch(/ease-in[^-]/);
            expect(css).not.toMatch(/@media[^{]*prefers-reduced-motion/); // driven by the live data-motion attribute
            const props = [
                ...css.matchAll(/transition(?:-property)?:\s*([^;{}]+)/g),
            ].flatMap((m) =>
                m[1]
                    .split(',')
                    .map((x) => x.trim().split(/\s+/)[0])
                    .filter((x) => x !== '' && x !== 'none'),
            );

            expect(props.length).toBeGreaterThan(5);

            for (const prop of props) {
                expect([
                    'transform',
                    'opacity',
                    'visibility',
                    'opacity,',
                ]).toContain(prop);
            }
        });
    });

    describe('keyboard', () => {
        it('Escape inside the widget calls the escape handler', () => {
            mount();
            q('button.launcher').dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    composed: true,
                }),
            );
            expect(handlers.escape).toHaveBeenCalledTimes(1);
            q('button.launcher').dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'a',
                    bubbles: true,
                    composed: true,
                }),
            );
            expect(handlers.escape).toHaveBeenCalledTimes(1);
        });
    });

    describe('panel frame', () => {
        it('toggles fullscreen mode, locks the launcher out of the tab order and restores it', () => {
            mount();
            ui.setOpen(true, true);
            expect(q('.panel').dataset.mode).toBe('fullscreen');
            expect(q('.root').dataset.fullscreen).toBe('true');
            ui.setOpen(false, true);
            expect(q('.root').dataset.fullscreen).toBe('false');
            ui.setOpen(true, false);
            expect(q('.panel').dataset.mode).toBe('panel');
        });

        it('hide() removes the whole widget from view', () => {
            mount();
            ui.setHidden(true);
            expect(ui.host.style.getPropertyValue('display')).toBe('none');
            ui.setHidden(false);
            expect(ui.host.style.getPropertyValue('display')).toBe('block');
        });
    });
});
