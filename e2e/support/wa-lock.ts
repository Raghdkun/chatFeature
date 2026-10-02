/**
 * A reader / writer lock between the WhatsApp specs of ONE scenario instance (they run in parallel Playwright workers against one app, one
 * Reverb and one OpenWA mock, and the mock, the `whatsapp.*` settings and the inbox totals are global to the instance).
 *
 *  - `shared`: a test that only touches what it created itself (its own session, its own phone numbers, its own widget). Any number of them
 *    run together.
 *  - `exclusive`: a test that changes something global (a setting, the mock's config / scripts / throttle, the connection to OpenWA) or
 *    asserts a global (the sidebar badge, the number of sessions). It runs alone: every shared test has finished, none starts.
 *
 * Writers are preferred (a waiting writer stops new readers) so an exclusive test is never starved. The lock lives in the instance's private
 * storage directory (wiped by `globalSetup` before every run) as plain files: `writer/` (a directory: `mkdir` is atomic), `pending/<id>`,
 * `readers/<id>`. Every entry names its owner process; an entry whose process is gone (a killed worker) or that is older than ten minutes is
 * ignored, so a crash never wedges a run.
 */
import {
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Instance } from './scenarios';

const STALE_AFTER_MS = 10 * 60_000;
const POLL_MS = 100;

let counter = 0;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function alive(path: string): boolean {
    let age: number;
    let owner: string;

    try {
        const info = statSync(path);

        age = Date.now() - info.mtimeMs;
        owner = info.isDirectory() ? join(path, 'owner') : path;
    } catch {
        return false;
    }

    if (age > STALE_AFTER_MS) {
        return false;
    }

    let pid: number;

    try {
        pid = Number.parseInt(readFileSync(owner, 'utf8'), 10);
    } catch {
        // Created a moment ago and its owner has not written its name yet: held.
        return age < 2_000;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

function live(directory: string): string[] {
    try {
        return readdirSync(directory)
            .map((name) => join(directory, name))
            .filter((path) => {
                if (alive(path)) {
                    return true;
                }

                rmSync(path, { recursive: true, force: true });

                return false;
            });
    } catch {
        return [];
    }
}

export type Release = () => void;

/** Waits for the lock; `exclusive` = alone in the instance. Returns the function that gives it back. */
export async function acquireScenarioLock(
    instance: Instance,
    mode: 'shared' | 'exclusive',
): Promise<Release> {
    const root = join(instance.dir, 'wa-lock');
    const writer = join(root, 'writer');
    const pending = join(root, 'pending');
    const readers = join(root, 'readers');
    const id = `${process.pid}-${(counter += 1)}-${Date.now()}`;

    mkdirSync(pending, { recursive: true });
    mkdirSync(readers, { recursive: true });

    if (mode === 'shared') {
        const mine = join(readers, id);

        for (;;) {
            if (live(pending).length === 0 && !alive(writer)) {
                writeFileSync(mine, String(process.pid));

                // A writer may have slipped in between the check and the entry: back off, it has priority.
                if (live(pending).length === 0 && !alive(writer)) {
                    return () => rmSync(mine, { force: true });
                }

                rmSync(mine, { force: true });
            }

            await sleep(POLL_MS);
        }
    }

    const wanted = join(pending, id);

    writeFileSync(wanted, String(process.pid));

    try {
        for (;;) {
            try {
                mkdirSync(writer);
                writeFileSync(join(writer, 'owner'), String(process.pid));

                break;
            } catch {
                if (!alive(writer)) {
                    rmSync(writer, { recursive: true, force: true });
                }

                await sleep(POLL_MS);
            }
        }

        while (live(readers).length > 0) {
            await sleep(POLL_MS);
        }
    } finally {
        rmSync(wanted, { force: true });
    }

    return () => rmSync(writer, { recursive: true, force: true });
}
