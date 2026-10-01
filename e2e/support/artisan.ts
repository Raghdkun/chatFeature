import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSafe, ROOT, type Instance } from './scenarios';

const execFileAsync = promisify(execFile);

/** `php` from PATH (the project targets PHP 8.4); override with E2E_PHP. */
const PHP = process.env.E2E_PHP ?? 'php';

/**
 * Run `php artisan ...` against ONE e2e instance. The instance environment (database, storage,
 * install state directory, ...) always wins over whatever `.env` or the shell says, and
 * `assertSafe` refuses to run for anything that is not a `chatfeature_e2e*` database.
 */
export async function artisan(
    instance: Instance,
    args: string[],
    extraEnv: Record<string, string> = {},
): Promise<string> {
    assertSafe(instance);

    try {
        const { stdout } = await execFileAsync(
            PHP,
            ['artisan', ...args, '--no-interaction'],
            {
                cwd: ROOT,
                env: { ...process.env, ...instance.env, ...extraEnv },
                timeout: 180_000,
                maxBuffer: 16 * 1024 * 1024,
            },
        );

        return stdout;
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };

        throw new Error(
            `php artisan ${args[0]} failed for ${instance.key}:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
            { cause: error },
        );
    }
}

/** Run a PHP snippet in the app context (`artisan tinker --execute`); data goes through the environment. */
export function tinker(
    instance: Instance,
    code: string,
    extraEnv: Record<string, string> = {},
): Promise<string> {
    return artisan(instance, ['tinker', '--execute', code], extraEnv);
}
