/**
 * What lets the real server talk to the suite's FAKE push service (e2e/support/push.ts) over https without a single hook in the product.
 *
 * A web push endpoint must be an https URL of a PUBLIC host (`PushEndpointGuard`: never a loopback or private address), and the server verifies
 * the certificate of the push service it posts to (Laravel's HTTP client, curl). So the specs' subscriptions name a vendor host
 * (`https://fcm.googleapis.com/fcm/send/<id>`: it resolves publicly, which is all registration checks), and the scenario's HTTP client reaches
 * the internet through the fake push service, an HTTP proxy for that one host (`HTTPS_PROXY`, scenarios.ts). What is left is trust: the fake
 * service presents a throw-away certificate for `fcm.googleapis.com`, so the scenario's PHP processes get their own `php.ini` (`PHPRC`) that is
 * the machine's php.ini plus `curl.cainfo` / `openssl.cafile` pointing at a bundle of the usual authorities AND that one certificate. Nothing
 * else changes: every other certificate is still verified.
 *
 * Everything lives in `storage/e2e-p5-trust/` (git-ignored, outside any scenario's own directory so the setup wipe leaves it alone):
 * `service.crt` / `service.key` (a self-signed EC certificate for `fcm.googleapis.com`, made with the `openssl` command line tool),
 * `ca-bundle.pem` and `php.ini`. Created on first use, remade after a day or when it was made for something else; the suite's config calls
 * `ensurePushTrust()` before any server starts (the servers read their php.ini at start-up).
 */
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** `PHPRC` of the scenarios that push: a directory holding `php.ini`. */
export const PUSH_TRUST_DIR = `${ROOT}storage/e2e-p5-trust`;
export const PUSH_CERT = `${PUSH_TRUST_DIR}/service.crt`;
export const PUSH_KEY = `${PUSH_TRUST_DIR}/service.key`;
/**
 * The vendor host the specs' subscriptions name and the fake push service answers for. Registering a subscription and every push look the
 * host up in DNS (public-host check), which on a machine with a slow resolver can take seconds; `E2E_PUSH_HOST=<public IPv4>` names the
 * vendor by an address instead (no lookup at all, nothing contacted either way: the fake service is the only thing ever reached).
 */
export const PUSH_HOST = process.env.E2E_PUSH_HOST ?? 'fcm.googleapis.com';
const HOST_MARK = `${PUSH_TRUST_DIR}/service.host`;

const PHP = process.env.E2E_PHP ?? 'php';
const DAY_MS = 24 * 60 * 60 * 1000;

function fresh(path: string): boolean {
    try {
        return (
            Date.now() - statSync(path).mtimeMs < DAY_MS &&
            readFileSync(HOST_MARK, 'utf8') === PUSH_HOST
        );
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

    // A day of validity is plenty; the subject alternative name must carry the host the endpoints name (curl checks it).
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
            `/CN=${PUSH_HOST}`,
            '-addext',
            `subjectAltName=${isIP(PUSH_HOST) === 0 ? 'DNS' : 'IP'}:${PUSH_HOST}`,
        ],
        { stdio: 'ignore' },
    );
    writeFileSync(HOST_MARK, PUSH_HOST);

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
