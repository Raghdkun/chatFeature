const SVG_NS = 'http://www.w3.org/2000/svg';

type Kid = Node | string | null | undefined | false;

/** Element factory. Attributes go through `setAttribute` and text through text nodes: never `innerHTML`. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string | null,
    attrs?: Record<string, string> | null,
    ...kids: Kid[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);

    if (cls) {
        el.className = cls;
    }

    for (const k of Object.keys(attrs ?? {})) {
        el.setAttribute(k, (attrs as Record<string, string>)[k]);
    }

    for (const kid of kids) {
        if (kid !== null && kid !== undefined && kid !== false) {
            el.append(kid);
        }
    }

    return el;
}

/** 24x24 stroke icon built with DOM APIs only (safe under Trusted Types and strict CSP). */
export function svg(paths: string[], cls: string): SVGSVGElement {
    const el = document.createElementNS(SVG_NS, 'svg');

    for (const [k, v] of Object.entries({
        class: cls,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        focusable: 'false',
    })) {
        el.setAttribute(k, v);
    }

    for (const d of paths) {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        el.append(p);
    }

    return el;
}

export const ICONS: Record<string, string[]> = {
    chat: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
    help: [
        'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
        'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3',
        'M12 17h.01',
    ],
    sparkle: [
        'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
        'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
    ],
    close: ['M18 6 6 18', 'M6 6l12 12'],
};

/** Dark or white text, whichever reads better on `bg` (3/6/8 digit hex), by perceived brightness. */
export function readableOn(bg: string): string {
    const c =
        bg.length < 6 ? bg.replace(/./g, (x) => x + x).slice(2) : bg.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));

    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#0f172a' : '#ffffff';
}
