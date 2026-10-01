/**
 * Browser APIs that Radix primitives (switch, checkbox, radio group, dialog) read and jsdom does
 * not provide. Import for the side effect at the top of a test file:
 *
 *   import '@/tests/polyfills';
 */
class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver =
        ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
}

if (typeof Element.prototype.hasPointerCapture !== 'function') {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
}

export {};
