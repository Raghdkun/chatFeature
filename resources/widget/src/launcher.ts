import { h, ICONS, readableOn, svg } from './dom';
import css from './styles.css?inline';
import type { Effective, Greeting } from './types';

/**
 * Launcher bubble/pill, greeting popup and panel frame inside an open shadow root. All config-derived values
 * reach the DOM through `textContent`, attributes set with `setAttribute` (never `style=`) or CSSOM
 * `setProperty`; markup is built with DOM APIs, never `innerHTML`.
 */

export interface UiHandlers {
    toggle: () => void;
    greetingClick: () => void;
    greetingDismiss: () => void;
    escape: () => void;
    /** First user gesture inside the widget (unlocks audio). */
    gesture: () => void;
}

export type FlipState = 'front' | 'to-agent' | 'agent' | 'to-front';

export const SIZES = { sm: 48, md: 60, lg: 72 } as const;
export const FLIP_IN_MS = 520;
export const FLIP_OUT_MS = 420;
export const FADE_MS = 220;
export const POPUP_EXIT_MS = 200;
export const ALERT_MS = 2800;

const SHADOWS = {
    none: 'none',
    soft: '0 6px 20px rgb(15 23 42 / 0.18), 0 2px 6px rgb(15 23 42 / 0.12)',
    strong: '0 12px 36px rgb(15 23 42 / 0.35), 0 4px 12px rgb(15 23 42 / 0.22)',
} as const;

const DARK = { surface: '#1f2937', text: '#f3f4f6' };

export interface GreetingFace {
    avatar: string | null;
    name: string | null;
    flip: boolean;
    dismissLabel: string;
}

const initials = (name: string): string =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => Array.from(w)[0].toUpperCase())
        .join('');

/** Avatar image, falling back to initials (or nothing) when there is no image or it fails to load. */
function avatar(url: string | null, name: string | null): HTMLElement | null {
    const fallback = (): HTMLElement | null =>
        name === null ? null : h('span', 'av', null, initials(name));

    if (url === null) {
        return fallback();
    }

    const img = h('img', 'av', {
        src: url,
        alt: '',
        decoding: 'async',
        referrerpolicy: 'no-referrer',
    });

    img.addEventListener('error', () => {
        const f = fallback();

        if (f === null) {
            img.remove();
        } else {
            img.replaceWith(f);
        }
    });

    return img;
}

export class Ui {
    readonly host: HTMLElement;
    readonly shadow: ShadowRoot;
    readonly root: HTMLElement;
    readonly panel: HTMLElement;
    readonly button: HTMLButtonElement;
    private readonly card: HTMLElement;
    private readonly front: HTMLElement;
    private readonly back: HTMLElement;
    private readonly badge: HTMLElement;
    private readonly live: HTMLElement;
    private greet: HTMLElement | null = null;
    private eff: Effective | null = null;
    private sig = '';
    private open = false;
    private count = 0;
    private reduced = false;
    flip: FlipState = 'front';
    private flipTimer: ReturnType<typeof setTimeout> | null = null;
    private exitTimer: ReturnType<typeof setTimeout> | null = null;
    private alertTimer: ReturnType<typeof setTimeout> | null = null;
    private fontLink: HTMLLinkElement | null = null;
    private gestured = false;

    constructor(
        private readonly handlers: UiHandlers,
        nonce?: string,
    ) {
        this.host = document.createElement('pne-chat-widget');
        this.shadow = this.host.attachShadow({ mode: 'open' });
        this.adoptStyles(nonce);

        this.front = h('span', 'face front');
        this.back = h('span', 'face back');
        this.card = h(
            'span',
            'card',
            { 'data-face': 'front', 'data-flip': 'front' },
            this.front,
            this.back,
        );
        this.badge = h('span', 'badge', { 'aria-hidden': 'true' });
        this.button = h(
            'button',
            'launcher',
            {
                type: 'button',
                'aria-haspopup': 'dialog',
                'aria-expanded': 'false',
                'aria-controls': 'pne-panel',
            },
            this.card,
            h('span', 'ring', { 'aria-hidden': 'true' }),
            this.badge,
        );
        this.live = h('div', 'live', { 'aria-live': 'polite' });
        this.panel = h('div', 'panel', {
            id: 'pne-panel',
            role: 'dialog',
            'data-open': 'false',
            'data-mode': 'panel',
            inert: '',
        });
        this.root = h(
            'div',
            'root',
            { 'data-motion': 'full', 'data-scheme': 'light' },
            h('div', 'dock', null, this.button, this.live),
            this.panel,
        );
        this.shadow.append(this.root);

        this.button.addEventListener('click', () => handlers.toggle());
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                handlers.escape();
            }
        });

        const gesture = (): void => {
            if (!this.gestured) {
                this.gestured = true;
                handlers.gesture();
            }
        };
        this.button.addEventListener('pointerdown', gesture);
        this.button.addEventListener('keydown', gesture);

        // Host element: reset every inherited/leaking property and pin it, beating host `!important` rules.
        const pin = (k: string, v: string): void =>
            this.host.style.setProperty(k, v, 'important');
        pin('all', 'initial');
        pin('display', 'block');
        pin('position', 'fixed');
        pin('inset', '0 auto auto 0');
        pin('width', '0');
        pin('height', '0');
        pin('overflow', 'visible');
        pin('pointer-events', 'none');
    }

    private adoptStyles(nonce?: string): void {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            this.shadow.adoptedStyleSheets = [sheet];

            return;
        } catch {
            // no constructable stylesheets (old browsers, jsdom): fall back to a <style> element
        }

        const style = h('style', null, nonce ? { nonce } : null, css);
        this.shadow.prepend(style);
    }

    mount(parent: HTMLElement): void {
        parent.append(this.host);
    }

    /** (Re)applies config: colours, geometry, texts, icon. Safe to call repeatedly. */
    apply(eff: Effective, dark: boolean): void {
        this.eff = eff;
        const t = eff.theme;
        const set = (k: string, v: string): void =>
            this.root.style.setProperty(k, v);
        set('--primary', t.primary);
        set('--primary-text', t.primaryText);
        set('--accent', t.accent);
        set('--accent-text', readableOn(t.accent));
        set('--surface', dark ? DARK.surface : t.surface);
        set('--text', dark ? DARK.text : t.text);
        set('--radius', `${t.radius}px`);
        set('--font', `${t.fontFamily},system-ui,sans-serif`);
        set('--size', `${SIZES[t.launcherSize]}px`);
        set('--ox', `${t.offsetX}px`);
        set('--oy', `${t.offsetY}px`);
        set('--pw', `${t.panelWidth}px`);
        set('--ph', `${t.panelHeight}px`);
        set('--shadow', SHADOWS[t.shadow]);
        this.host.style.setProperty('z-index', String(t.zIndex), 'important');
        this.root.dataset.pos = t.position;
        this.root.dataset.scheme = dark ? 'dark' : 'light';
        this.root.setAttribute('dir', eff.dir);
        this.button.dataset.style = eff.launcher.style;
        this.panel.setAttribute('aria-label', eff.text('title', 'Chat'));
        this.buildFront(eff);
        this.syncLabel();
        this.setFont(t.fontUrl);
    }

    private buildFront(eff: Effective): void {
        const l = eff.launcher;
        const sig = [l.style, l.icon, l.iconUrl, l.label].join('|');

        if (sig === this.sig) {
            return;
        }

        this.sig = sig;
        let main: Element;

        if (l.icon === 'custom' && l.iconUrl !== null) {
            const img = h('img', 'ico-main', {
                src: l.iconUrl,
                alt: '',
                decoding: 'async',
                referrerpolicy: 'no-referrer',
            });
            img.addEventListener('error', () =>
                img.replaceWith(svg(ICONS.chat, 'ico-main')),
            );
            main = img;
        } else {
            main = svg(
                ICONS[l.icon === 'custom' ? 'chat' : l.icon],
                'ico-main',
            );
        }

        this.front.replaceChildren(
            ...[
                h('span', 'icons', null, main, svg(ICONS.close, 'ico-close')),
                l.style === 'pill' ? h('span', 'lbl', null, l.label) : null,
            ].filter((n) => n !== null),
        );
    }

    private syncLabel(): void {
        const eff = this.eff;

        if (eff === null) {
            return;
        }

        const base = this.open
            ? eff.text('closeChat', 'Close chat')
            : eff.launcher.label;

        this.button.setAttribute(
            'aria-label',
            !this.open && this.count > 0
                ? `${base}, ${this.count} ${eff.text('unread', 'unread messages')}`
                : base,
        );
    }

    private setFont(url: string | null): void {
        if (url === (this.fontLink?.href ?? null)) {
            return;
        }

        this.fontLink?.remove();
        this.fontLink = null;

        if (url !== null) {
            // @font-face rules are ignored inside shadow roots, so the stylesheet has to live in the document.
            this.fontLink = h('link', null, {
                rel: 'stylesheet',
                href: url,
                'data-pne-chat-font': '',
            });
            document.head.append(this.fontLink);
        }
    }

    setScheme(dark: boolean): void {
        if (this.eff !== null) {
            this.apply(this.eff, dark);
        }
    }

    setMotion(reduced: boolean): void {
        this.reduced = reduced;
        this.root.dataset.motion = reduced ? 'reduced' : 'full';
    }

    setHidden(hidden: boolean): void {
        this.host.style.setProperty(
            'display',
            hidden ? 'none' : 'block',
            'important',
        );
    }

    setOpen(open: boolean, fullscreen: boolean): void {
        this.open = open;
        this.button.setAttribute('aria-expanded', String(open));
        this.panel.dataset.open = String(open);
        this.panel.toggleAttribute('inert', !open);
        this.setFullscreen(fullscreen);
        this.root.dataset.fullscreen = String(open && fullscreen);
        this.syncLabel();
    }

    setFullscreen(fullscreen: boolean): void {
        this.panel.dataset.mode = fullscreen ? 'fullscreen' : 'panel';
        this.root.dataset.fullscreen = String(this.open && fullscreen);
    }

    setBadge(n: number): void {
        this.count = n;
        this.badge.textContent = n > 99 ? '99+' : String(n);
        this.badge.dataset.show = String(n > 0 && !this.open);
        this.syncLabel();
    }

    /** Shake + ring for ~3 s (opacity blink under reduced motion). */
    alert(): void {
        this.button.dataset.alert = 'false';
        void this.button.offsetWidth;
        this.button.dataset.alert = 'true';

        if (this.alertTimer !== null) {
            clearTimeout(this.alertTimer);
        }

        this.alertTimer = setTimeout(() => {
            this.button.dataset.alert = 'false';
            this.alertTimer = null;
        }, ALERT_MS);
    }

    focusLauncher(): void {
        this.button.focus();
    }

    panelHasFocus(): boolean {
        return (
            this.shadow.activeElement !== null &&
            this.panel.contains(this.shadow.activeElement)
        );
    }

    /* ------------------------------------------------------------ greeting */

    get greetingVisible(): boolean {
        return this.greet !== null;
    }

    /** Flips the launcher to the agent face and slides the popup in beside it (bottom sheet on mobile). */
    showGreeting(g: Greeting, face: GreetingFace): void {
        this.removeGreeting();
        const popupAvatar = avatar(face.avatar, face.name);

        const x = h(
            'button',
            'g-x',
            { type: 'button', 'aria-label': face.dismissLabel },
            svg(ICONS.close, 'g-ico'),
        );
        x.addEventListener('click', () => this.handlers.greetingDismiss());

        const main = h(
            'button',
            'g-main',
            { type: 'button' },
            popupAvatar === null ? null : h('span', 'g-av', null, popupAvatar),
            h(
                'span',
                'g-text',
                null,
                face.name === null
                    ? null
                    : h('span', 'g-name', null, face.name),
                h('span', 'g-body', null, g.body),
            ),
        );
        main.addEventListener('click', () => this.handlers.greetingClick());

        const card = h('div', 'greet', { 'data-state': 'enter' }, main, x);
        this.greet = card;
        this.live.append(card);
        void card.getBoundingClientRect();
        card.dataset.state = 'open';

        const backAvatar = face.flip ? avatar(face.avatar, face.name) : null;

        if (backAvatar !== null) {
            this.back.replaceChildren(
                ...[
                    backAvatar,
                    this.eff?.launcher.style === 'pill' && face.name !== null
                        ? h('span', 'nm', null, face.name)
                        : null,
                ].filter((n) => n !== null),
            );
            this.flipTo('agent');
        }
    }

    hideGreeting(): void {
        const card = this.greet;

        if (card === null) {
            return;
        }

        this.greet = null;
        card.dataset.state = 'exit';
        card.setAttribute('inert', '');
        this.flipTo('front');
        this.exitTimer = setTimeout(() => {
            card.remove();
            this.exitTimer = null;
        }, POPUP_EXIT_MS);
    }

    private removeGreeting(): void {
        if (this.exitTimer !== null) {
            clearTimeout(this.exitTimer);
            this.exitTimer = null;
        }

        this.live.replaceChildren();
        this.greet = null;
    }

    private flipTo(face: 'front' | 'agent'): void {
        if (this.flipTimer !== null) {
            clearTimeout(this.flipTimer);
        }

        this.card.dataset.face = face;
        this.setFlip(face === 'agent' ? 'to-agent' : 'to-front');
        this.flipTimer = setTimeout(
            () => {
                this.flipTimer = null;
                this.setFlip(face);
            },
            this.reduced
                ? FADE_MS
                : face === 'agent'
                  ? FLIP_IN_MS
                  : FLIP_OUT_MS,
        );
    }

    private setFlip(s: FlipState): void {
        this.flip = s;
        this.card.dataset.flip = s;
    }

    destroy(): void {
        for (const t of [this.flipTimer, this.exitTimer, this.alertTimer]) {
            if (t !== null) {
                clearTimeout(t);
            }
        }

        this.flipTimer = this.exitTimer = this.alertTimer = null;
        this.fontLink?.remove();
        this.fontLink = null;
        this.host.remove();
    }
}
