/**
 * One MSW server per test file: import this module, then `const backend = useBackend()` in a test (or `beforeEach`). Unhandled
 * requests fail the test (a panel that calls an endpoint nobody mocked is a bug, and "never calls the visitor API" is assertable).
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vite-plus/test';
import {
    createVisitorBackend,
    type BackendOptions,
    type VisitorBackend,
} from '@/tests/msw/chat-visitor';

export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

export function useBackend(options: BackendOptions = {}): VisitorBackend {
    const backend = createVisitorBackend(options);

    server.use(...backend.handlers);

    return backend;
}
