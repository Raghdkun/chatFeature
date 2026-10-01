/**
 * "Never in plain text": helpers that look for a secret (a service token) in what the app wrote to disk
 * or sent to a browser. A secret is searched in the forms it could plausibly show up in: as typed, JSON
 * escaped (`/` -> `\/`), URL encoded and HTML escaped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';

export function variantsOf(secret: string): string[] {
    const forms = new Set<string>([
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
        secret
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;'),
    ]);

    return [...forms];
}

export function containsSecret(text: string, secret: string): boolean {
    return variantsOf(secret).some((form) => text.includes(form));
}

/** Every file under `directory` (recursively) whose content holds `secret`, as a path relative to it. */
export function filesContainingSecret(
    directory: string,
    secret: string,
): string[] {
    const found: string[] = [];

    const walk = (current: string): void => {
        for (const entry of readdirSync(current)) {
            const path = `${current}/${entry}`;
            const stats = statSync(path);

            if (stats.isDirectory()) {
                walk(path);
            } else if (stats.size < 20 * 1024 * 1024) {
                if (containsSecret(readFileSync(path, 'latin1'), secret)) {
                    found.push(path.slice(directory.length + 1));
                }
            }
        }
    };

    walk(directory);

    return found;
}
