/**
 * The route table of the app, read from the PHP route files themselves (raw text, no PHP and no process: fast and independent of the
 * machine, like `lib/limits.test.ts` which pins the client limits to the PHP rules). It understands exactly the style the route files
 * of this project are written in: `Route::<verb>('uri', ...)` lines, and `->prefix('x')...->group(function () {` blocks closed by `});`.
 * The result is what the contract tests compare the client's URL builders with, so a URL or a verb that is not routed fails a test.
 *
 * Where each directory is mounted (`routes/api.php`, `bootstrap/app.php`): management `/api/v1`, public `/api/v1/public`, web `/`.
 */

export type PhpRoute = {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Normalised: leading slash, parameters as `{}`. */
    uri: string;
};

const sources = import.meta.glob<string>(
    [
        '/routes/api/management/*.php',
        '/routes/api/public/*.php',
        '/routes/web/*.php',
        '/routes/web.php',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const MOUNT: [RegExp, string][] = [
    [/^\/routes\/api\/management\//, '/api/v1'],
    [/^\/routes\/api\/public\//, '/api/v1/public'],
    [/^\/routes\/web(\.php|\/)/, ''],
];

const VERB = /(?:Route::|->)(get|post|put|patch|delete|inertia)\(\s*'([^']*)'/;
const GROUP_OPEN = /->group\(function\s*\(\)\s*\{\s*$/;
const GROUP_CLOSE = /^\s*\}\);\s*$/;
const PREFIX = /prefix\('([^']*)'\)/;

const join = (...parts: string[]): string =>
    '/' +
    parts
        .flatMap((part) => part.split('/'))
        .filter((segment) => segment !== '')
        .join('/');

/** Every route a PHP route file defines, with the prefixes of the groups around it and the mount point of its directory. */
export function parseRoutes(source: string, mount = ''): PhpRoute[] {
    const routes: PhpRoute[] = [];
    const prefixes: string[] = [];
    /** A `Route::prefix('x')` chain whose `->group(function () {` is on a later line. */
    let pending: string | null = null;

    for (const line of source.split('\n')) {
        const code = line.replace(/\/\/.*$/, '');

        if (/^\s*(\/\*|\*|\|)/.test(code)) {
            continue;
        }

        if (GROUP_CLOSE.test(code)) {
            prefixes.pop();
            continue;
        }

        const verb = VERB.exec(code);

        if (verb && !GROUP_OPEN.test(code)) {
            routes.push({
                method:
                    verb[1] === 'inertia'
                        ? 'GET'
                        : (verb[1].toUpperCase() as PhpRoute['method']),
                uri: join(mount, ...prefixes, verb[2]).replace(
                    /\{[^}/]+\}/g,
                    '{}',
                ),
            });
        }

        const named = PREFIX.exec(code)?.[1];

        if (named !== undefined) {
            pending = named;
        }

        if (GROUP_OPEN.test(code)) {
            prefixes.push(pending ?? '');
            pending = null;
        } else if (code.trimEnd().endsWith(';')) {
            pending = null;
        }
    }

    return routes;
}

/** The whole route table, as `METHOD /uri` strings. */
export function routeTable(): Set<string> {
    const table = new Set<string>();

    for (const [path, source] of Object.entries(sources)) {
        const mount = MOUNT.find(([pattern]) => pattern.test(path))?.[1] ?? '';

        for (const route of parseRoutes(source, mount)) {
            table.add(`${route.method} ${route.uri}`);
        }
    }

    return table;
}

/** A URL as a builder writes it, with `{}` for its parameters: pass a builder and the number of ids it takes. */
export function pathOf(build: (...ids: string[]) => string, ids = 0): string {
    const sentinel = '__ID__';
    const url = build(...Array.from({ length: ids }, () => sentinel));

    return url.replace(new RegExp(sentinel, 'g'), '{}').split('?')[0];
}
