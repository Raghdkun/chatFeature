/** Extra DOM helpers for the dashboard screens (complements `render.tsx`). */
import { act } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Types into an input OR textarea the way a user would (fires React's onChange). */
export async function fill(
    element: Field | null,
    value: string,
): Promise<void> {
    if (!element) {
        throw new Error('fill(): element not found');
    }

    const prototype =
        element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
    const { set } = Object.getOwnPropertyDescriptor(prototype, 'value') as {
        set: (this: Field, next: string) => void;
    };

    await act(async () => {
        set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

export async function choose(
    select: HTMLSelectElement | null,
    value: string,
): Promise<void> {
    if (!select) {
        throw new Error('choose(): select not found');
    }

    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

export async function blur(element: HTMLElement | null): Promise<void> {
    if (!element) {
        throw new Error('blur(): element not found');
    }

    await act(async () => {
        element.focus();
        element.blur();
    });
}

export async function keyDown(
    element: HTMLElement | null,
    key: string,
): Promise<void> {
    if (!element) {
        throw new Error('keyDown(): element not found');
    }

    await act(async () => {
        element.dispatchEvent(
            new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
            }),
        );
    });
}

/** Radix tabs / menus activate on `mousedown`, not `click`. */
export async function mouseDown(element: HTMLElement | null): Promise<void> {
    if (!element) {
        throw new Error('mouseDown(): element not found');
    }

    await act(async () => {
        element.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, button: 0 }),
        );
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        element.focus();
    });
}

/** Submits the form that contains `element` (jsdom's `requestSubmit` runs validation first). */
export async function submit(element: HTMLElement | null): Promise<void> {
    const form = element?.closest('form');

    if (!form) {
        throw new Error('submit(): no form around element');
    }

    await act(async () => {
        form.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
}

/** Radix portals dialogs / popovers into `document.body`. */
export const body = {
    byTestId: (id: string) =>
        document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`),
    allByTestId: (id: string) =>
        Array.from(
            document.body.querySelectorAll<HTMLElement>(
                `[data-testid="${id}"]`,
            ),
        ),
    text: () => document.body.textContent ?? '',
};

export function byTestId<T extends HTMLElement = HTMLElement>(
    root: ParentNode,
    id: string,
): T | null {
    return root.querySelector<T>(`[data-testid="${id}"]`);
}

/** The form control a `<label>` with exactly this text points at (searches `root`, labels may live in portals). */
export function byLabelText<T extends HTMLElement = HTMLInputElement>(
    root: ParentNode,
    text: string,
): T | null {
    const label = Array.from(root.querySelectorAll('label')).find(
        (candidate) => candidate.textContent?.trim() === text,
    );

    if (!label) {
        return null;
    }

    if (label.htmlFor) {
        return document.getElementById(label.htmlFor) as T | null;
    }

    return label.querySelector<T>('input, select, textarea, button');
}

export function byAriaLabel<T extends HTMLElement = HTMLInputElement>(
    root: ParentNode,
    label: string,
): T | null {
    return root.querySelector<T>(`[aria-label="${label}"]`);
}

/** A radio in a native radio group, found by its visible label. */
export function radio(
    root: ParentNode,
    label: string,
): HTMLInputElement | null {
    const match = Array.from(root.querySelectorAll('label')).find(
        (candidate) => candidate.textContent?.trim() === label,
    );

    return (
        match?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null
    );
}
