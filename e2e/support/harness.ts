/**
 * The local throwaway pizzasys ("Auth Portal") the mode-2 scenarios talk to.
 *
 * It lives OUTSIDE the repository (`../chatFeature.harness`, override with E2E_HARNESS_DIR) and is
 * controlled through its own `run.sh start|stop|status|reset`. Its test accounts and service tokens are
 * read from `secrets.local.env` at runtime: nothing from that file is ever copied into the repository, a
 * spec, a report or a log. Port 8200 must be free when the suite starts (docs/testing.md).
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ROOT } from './scenarios';

const execFileAsync = promisify(execFile);

export const HARNESS_DIR = (
    process.env.E2E_HARNESS_DIR ?? `${ROOT}../chatFeature.harness`
).replace(/\/+$/, '');
export const HARNESS_URL = 'http://127.0.0.1:8200';

const PHP = process.env.E2E_PHP ?? 'php';

export type HarnessSecrets = {
    baseUrl: string;
    /** The valid service client of PNE Chat. */
    service: { name: string; token: string };
    /** A second, valid service client (used as the "Testing" environment). */
    other: { name: string; token: string };
    inactive: { name: string; token: string };
    expired: { name: string; token: string };
    /** Shared by every test account. */
    password: string;
};

let cached: HarnessSecrets | undefined;

/** Parse `secrets.local.env` (KEY=VALUE lines; values may contain `=`, `+` and `/`). */
export function harnessSecrets(): HarnessSecrets {
    if (cached) {
        return cached;
    }

    const values: Record<string, string> = {};

    for (const line of readFileSync(
        `${HARNESS_DIR}/secrets.local.env`,
        'utf8',
    ).split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());

        if (match) {
            values[match[1]] = match[2];
        }
    }

    const need = (key: string): string => {
        const value = values[key];

        if (!value) {
            throw new Error(
                `${key} is missing from ${HARNESS_DIR}/secrets.local.env (run ${HARNESS_DIR}/run.sh reset).`,
            );
        }

        return value;
    };

    cached = {
        baseUrl: values.PIZZASYS_BASE_URL ?? HARNESS_URL,
        service: {
            name: need('PIZZASYS_SERVICE_NAME'),
            token: need('PIZZASYS_SERVICE_TOKEN'),
        },
        other: {
            name: need('OTHER_SERVICE_NAME'),
            token: need('OTHER_SERVICE_TOKEN'),
        },
        inactive: {
            name: need('INACTIVE_SERVICE_NAME'),
            token: need('INACTIVE_SERVICE_TOKEN'),
        },
        expired: {
            name: need('EXPIRED_SERVICE_NAME'),
            token: need('EXPIRED_SERVICE_TOKEN'),
        },
        password: need('TEST_USER_PASSWORD'),
    };

    return cached;
}

/** `run.sh <command>`; `start` is daemonised by the script, so only the script's own exit is awaited. */
async function runScript(
    command: 'start' | 'stop' | 'status',
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(`${HARNESS_DIR}/run.sh`, [command], {
            // The daemon must not keep our pipes open; never inherit stdin.
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' },
        });
        let output = '';

        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(
                    new Error(
                        `harness run.sh ${command} exited with ${code}: ${output.trim()}`,
                    ),
                );
            }
        });
    });
}

export async function harnessIsUp(): Promise<boolean> {
    return (await runScript('status')).startsWith('UP');
}

export async function stopHarness(): Promise<void> {
    await runScript('stop');
}

export async function startHarness(): Promise<void> {
    await runScript('start');

    if (!(await harnessIsUp())) {
        throw new Error('The pizzasys harness did not come up on 8200.');
    }
}

/**
 * Fresh start of the harness for a suite run. Refuses to continue when something that is not this
 * harness already answers on 8200 (`stop` only ever kills the harness's own processes).
 */
export async function bootHarness(): Promise<void> {
    await stopHarness();

    if (await harnessIsUp()) {
        throw new Error(
            "Port 8200 is already taken by something that is not this suite's pizzasys harness. Free it and run again.",
        );
    }

    await startHarness();
}

/** Run PHP inside the harness app (`php artisan tinker --execute`); data goes through the environment. */
export async function harnessTinker(
    code: string,
    env: Record<string, string> = {},
): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            PHP,
            ['artisan', 'tinker', '--execute', code, '--no-interaction'],
            {
                cwd: `${HARNESS_DIR}/pizzasys`,
                env: { ...process.env, ...env },
                timeout: 120_000,
                maxBuffer: 8 * 1024 * 1024,
            },
        );

        return stdout.trim();
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };

        throw new Error(
            `harness tinker failed:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
            { cause: error },
        );
    }
}

/** Accounts only this suite uses (so permission edits never disturb the shared test users). */
export const roleChangeEmail = (project: 'desktop' | 'mobile'): string =>
    `e2e.roles.${project}@test.local`;

export const E2E_PORTAL_EMAILS = [
    roleChangeEmail('desktop'),
    roleChangeEmail('mobile'),
];

/** Create (or reset) the suite's own portal accounts: plain agents with the `chat.agent` permission. */
export async function ensureHarnessUsers(): Promise<void> {
    await harnessTinker(
        `
foreach (explode(',', (string) getenv('E2E_PORTAL_EMAILS')) as $email) {
    $user = App\\Models\\User::firstOrCreate(
        ['email' => $email],
        ['name' => 'E2E Roles', 'password' => Illuminate\\Support\\Facades\\Hash::make((string) getenv('E2E_PORTAL_PASSWORD')), 'email_verified_at' => now()]
    );
    $user->syncRoles([]);
    $user->syncPermissions(['chat.agent']);
}
`,
        {
            E2E_PORTAL_EMAILS: E2E_PORTAL_EMAILS.join(','),
            E2E_PORTAL_PASSWORD: harnessSecrets().password,
        },
    );
}

/** Replace the direct permissions of a portal account (what an admin of the portal would do). */
export async function setPortalPermissions(
    email: string,
    permissions: string[],
): Promise<void> {
    await harnessTinker(
        `
$user = App\\Models\\User::where('email', getenv('E2E_PORTAL_EMAIL'))->firstOrFail();
$user->syncPermissions(array_values(array_filter(explode(',', (string) getenv('E2E_PORTAL_PERMISSIONS')))));
`,
        {
            E2E_PORTAL_EMAIL: email,
            E2E_PORTAL_PERMISSIONS: permissions.join(','),
        },
    );
}

/** The portal's own `POST /auth/logout`: deletes exactly the presented user token. */
export async function revokePortalToken(token: string): Promise<void> {
    const response = await fetch(
        `${harnessSecrets().baseUrl}/api/v1/auth/logout`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
        },
    );

    if (!response.ok) {
        throw new Error(`Portal logout answered HTTP ${response.status}.`);
    }
}
