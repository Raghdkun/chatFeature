/**
 * jsdom lacks a few browser APIs the shell and Radix primitives touch. Import this FIRST in a test
 * file (`import '@/tests/dom-polyfills'`): ES imports evaluate in order, and some modules
 * (`use-mobile`) call `matchMedia` while they are being imported.
 */

let viewportWidth = 1440;

/** Width the fake `matchMedia` reports; `(min-width: N)` / `(max-width: N)` queries follow it. */
export function setViewportWidth(width: number): void {
    viewportWidth = width;
}

function matches(query: string): boolean {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);

    if (min) {
        return viewportWidth >= Number(min[1]);
    }

    if (max) {
        return viewportWidth <= Number(max[1]);
    }

    return false;
}

window.matchMedia = ((query: string) => ({
    get matches() {
        return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
})) as typeof window.matchMedia;

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

globalThis.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver;

// Assigned through a record so the "unbound method" lint does not mistake these for method reads.
const element = Element.prototype as unknown as Record<string, unknown>;
const htmlElement = HTMLElement.prototype as unknown as Record<string, unknown>;

element.scrollIntoView ??= () => {};
htmlElement.hasPointerCapture ??= () => false;
htmlElement.setPointerCapture ??= () => {};
htmlElement.releasePointerCapture ??= () => {};
