/**
 * What lets the real server talk to the suite's FAKE push service (e2e/support/push.ts) over https without a single hook in the product.
 *
 * A web push endpoint must be https (`PushEndpointGuard`), and the server verifies the certificate of the push service it posts to
 * (Laravel's HTTP client, curl). The e2e scenarios run `APP_ENV=local`, where the SSRF guard lets a loopback address through (a private
 * network is allowed in development, exactly like a Docker or VPN install with `PORTAL_ALLOW_PRIVATE_HOSTS`), so an endpoint such as
 * `https://127.0.0.1:8398/send/<id>` is accepted at registration and again before every send. What is left is trust: the fake service
 * presents a throw-away certificate, so the scenario's PHP processes get their own `php.ini` (`PHPRC`) that is the machine's php.ini plus
 * `curl.cainfo` / `openssl.cafile` pointing at a bundle of the usual authorities AND that one certificate. Nothing else changes: every
 * other certificate is still verified.
 *
 * Everything lives in `storage/e2e-p5-trust/` (git-ignored, outside any scenario's own directory so the setup wipe leaves it alone):
 * `service.crt` / `service.key` (a self-signed EC certificate for `127.0.0.1` / `localhost`, made with the `openssl` command line tool),
 * `ca-bundle.pem` and `php.ini`. Created on first use, remade after a day; the suite's config calls `ensurePushTrust()` before any server
 * starts (the servers read their php.ini at start-up).
 */
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** `PHPRC` of the scenarios that push: a directory holding `php.ini`. */
export const PUSH_TRUST_DIR = `${ROOT}storage/e2e-p5-trust`;
export const PUSH_CERT = `${PUSH_TRUST_DIR}/service.crt`;
export const PUSH_KEY = `${PUSH_TRUST_DIR}/service.key`;

const PHP = process.env.E2E_PHP ?? 'php';
const DAY_MS = 24 * 60 * 60 * 1000;

function fresh(path: string): boolean {
    try {
        return Date.now() - statSync(path).mtimeMs < DAY_MS;
    } catch {
        return false;
    }
}

/** Idempotent and cheap once the files exist. Throws a readable error when `openssl` or `php` cannot do their part. */
export function ensurePushTrust(): void {
    if (
        fresh(PUSH_CERT) &&
        existsSync(PUSH_KEY) &&
        existsSync(`${PUSH_TRUST_DIR}/php.ini`)
    ) {
        return;
    }

    mkdirSync(PUSH_TRUST_DIR, { recursive: true });

    // A day of validity is plenty; the subject alternative name must carry the IP the endpoints use (curl checks it).
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'ec',
            '-pkeyopt',
            'ec_paramgen_curve:prime256v1',
            '-nodes',
            '-keyout',
            PUSH_KEY,
            '-out',
            PUSH_CERT,
            '-days',
            '2',
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1,DNS:localhost',
        ],
        { stdio: 'ignore' },
    );

    const loaded = execFileSync(
        PHP,
        ['-r', 'echo (string) php_ini_loaded_file();'],
        { encoding: 'utf8' },
    ).trim();
    const base = loaded === '' ? '' : readFileSync(loaded, 'utf8');
    const authorities = execFileSync(
        PHP,
        ['-r', 'echo (string) ini_get("curl.cainfo");'],
        { encoding: 'utf8' },
    ).trim();
    const bundle = `${PUSH_TRUST_DIR}/ca-bundle.pem`;

    writeFileSync(
        bundle,
        `${authorities !== '' && existsSync(authorities) ? readFileSync(authorities, 'utf8') : ''}\n${readFileSync(PUSH_CERT, 'utf8')}`,
    );
    writeFileSync(
        `${PUSH_TRUST_DIR}/php.ini`,
        `${base}\ncurl.cainfo=${bundle}\nopenssl.cafile=${bundle}\n`,
    );
}
