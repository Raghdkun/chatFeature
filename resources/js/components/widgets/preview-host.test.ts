import vm from 'node:vm';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
    buildPreviewHostDocument,
    escapeHtml,
    RELAY_SOURCE,
    safeJson,
} from '@/components/widgets/preview-host';
import {
    buildDraftMessage,
    buildCommandMessage,
} from '@/components/widgets/preview-protocol';
import { buildPreviewBoot, defaultWidgetConfig } from '@/lib/widget-config';

const boot = (body = 'Hello') =>
    buildPreviewBoot({
        key: 'wk_abc',
        configVersion: 3,
        config: defaultWidgetConfig(),
        greetings: [
            {
                id: 'g1',
                body,
                agent_name: 'Sara',
                agent_avatar_url: null,
                locale: null,
                weight: 1,
                is_active: true,
            },
        ],
        categories: [{ slug: 'sales', label: 'Sales' }],
        preview: {
            embed_url: 'https://chat.example.test/embed/wk_abc',
            app_origin: 'https://chat.example.test',
        },
    });

const documentFor = (overrides = {}) =>
    buildPreviewHostDocument({
        boot: boot(),
        loaderUrl: 'https://chat.example.test/widget/v1/loader.js',
        dir: 'ltr',
        scheme: 'light',
        lang: 'en',
        siteName: 'Your website',
        ...overrides,
    });

describe('escaping', () => {
    it('makes JSON safe for an inline script', () => {
        const json = safeJson({
            x: '</script><script>alert(1)</script>',
            y: 'a & b',
            z: '  ',
        });

        expect(json).not.toContain('</script');
        expect(json).not.toContain('<');
        expect(json).not.toContain('>');
        expect(json).not.toContain(' ');
        expect(json).not.toContain(' ');
        expect(JSON.parse(json)).toEqual({
            x: '</script><script>alert(1)</script>',
            y: 'a & b',
            z: '  ',
        });
    });

    it('escapes HTML attribute and text content', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
            '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
        );
    });
});

describe('preview host document', () => {
    it('loads the real loader with the widget key and registers the draft boot config first', () => {
        const html = documentFor();
        const bootIndex = html.indexOf('window.__PNE_CHAT_BOOT__');
        const loaderIndex = html.indexOf(
            '<script src="https://chat.example.test/widget/v1/loader.js"',
        );

        expect(bootIndex).toBeGreaterThan(0);
        expect(loaderIndex).toBeGreaterThan(bootIndex);
        expect(html).toContain('data-widget-key="wk_abc"');
        expect(html).toContain('data-open-on-load="false"');
        expect(html).toContain('window.__PNE_CHAT_BOOT__["wk_abc"]={"v":1');
        expect(html).toContain('/embed/wk_abc?preview=1');
    });

    it('sets language, direction and color scheme of the mock page', () => {
        const rtl = documentFor({ dir: 'rtl', lang: 'ar', scheme: 'dark' });

        expect(rtl).toContain(
            '<html lang="ar" dir="rtl" style="color-scheme:dark">',
        );
        expect(rtl).toContain('data-scheme="dark"');
        expect(documentFor()).toContain('dir="ltr"');
    });

    it('cannot be broken out of by admin-controlled text', () => {
        const html = documentFor({
            boot: boot('</script><img src=x onerror=alert(1)>'),
            siteName: '"><script>alert(2)</script>',
        });

        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>alert(2)');
        expect(html.match(/<script/g)).toHaveLength(3);
    });

    it('does not rely on physical left/right in its own CSS', () => {
        expect(documentFor()).not.toMatch(
            /margin-(left|right)|padding-(left|right)|text-align:\s*(left|right)/,
        );
    });
});

/** Runs the relay (a plain ES5 string) against a fake browser. */
function startRelay() {
    const listeners: ((event: unknown) => void)[] = [];
    const parent = { postMessage: vi.fn() };
    const chatWindow = { postMessage: vi.fn() };
    const frame = {
        getAttribute: (name: string) =>
            name === 'src'
                ? 'https://chat.example.test/embed/wk_abc?preview=1'
                : null,
        contentWindow: chatWindow,
        addEventListener: vi.fn(),
    };
    // The loader mounts its UI in an open shadow root: the relay must look inside.
    const shadowHost = {
        shadowRoot: {
            querySelectorAll: (selector: string) =>
                selector === 'iframe' ? [frame] : [],
        },
    };
    const doc = {
        querySelectorAll: (selector: string) =>
            selector === 'iframe' ? [] : [shadowHost],
        querySelector: () => null,
    };
    const chatFeature = vi.fn();
    const win = {
        __PNE_PREVIEW__: {
            key: 'wk_abc',
            embedOrigin: 'https://chat.example.test',
        },
        origin: 'https://app.example.test',
        parent,
        ChatFeature: chatFeature,
        addEventListener: (_type: string, listener: (event: unknown) => void) =>
            listeners.push(listener),
    };

    // Run the relay source in its own context, with the fake browser as its globals.
    vm.runInNewContext(RELAY_SOURCE, {
        window: win,
        document: doc,
        setInterval: () => 1,
        clearInterval: () => undefined,
    });

    return {
        parent,
        chatWindow,
        chatFeature,
        win,
        send: (event: { source: unknown; origin: string; data: unknown }) =>
            listeners.forEach((l) => l(event)),
    };
}

describe('relay', () => {
    const draft = buildDraftMessage(defaultWidgetConfig(), []);

    it('forwards a draft from its parent to the chat iframe (found in the shadow DOM) with the embed origin as target', () => {
        const relay = startRelay();

        relay.send({
            source: relay.parent,
            origin: 'https://app.example.test',
            data: draft,
        });

        expect(relay.chatWindow.postMessage).toHaveBeenCalledWith(
            draft,
            'https://chat.example.test',
        );
    });

    it('also restyles the launcher through ChatFeature("update") with only the restyleable keys', () => {
        const relay = startRelay();

        relay.send({
            source: relay.parent,
            origin: 'https://app.example.test',
            data: draft,
        });

        expect(relay.chatFeature).toHaveBeenCalledTimes(1);

        const [command, overrides] = relay.chatFeature.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];

        expect(command).toBe('update');
        expect(Object.keys(overrides).sort()).toEqual([
            'defaultLocale',
            'greetings',
            'launcher',
            'texts',
            'theme',
        ]);
    });

    it('ignores drafts from any other window or origin', () => {
        const relay = startRelay();

        relay.send({
            source: {},
            origin: 'https://app.example.test',
            data: draft,
        });
        relay.send({
            source: relay.parent,
            origin: 'https://evil.example',
            data: draft,
        });

        expect(relay.chatWindow.postMessage).not.toHaveBeenCalled();
        expect(relay.chatFeature).not.toHaveBeenCalled();
    });

    it('ignores other namespaces, versions and message types', () => {
        const relay = startRelay();
        const from = {
            source: relay.parent,
            origin: 'https://app.example.test',
        };

        relay.send({ ...from, data: { ...draft, ns: 'other' } });
        relay.send({ ...from, data: { ...draft, v: 2 } });
        relay.send({ ...from, data: { ...draft, type: 'init' } });
        relay.send({ ...from, data: null });
        relay.send({ ...from, data: 'draft' });

        expect(relay.chatWindow.postMessage).not.toHaveBeenCalled();
    });

    it('opens and closes the chat panel on command, and only for known commands', () => {
        const relay = startRelay();
        const from = {
            source: relay.parent,
            origin: 'https://app.example.test',
        };

        relay.send({ ...from, data: buildCommandMessage('open') });
        relay.send({ ...from, data: buildCommandMessage('close') });
        relay.send({
            ...from,
            data: { ...buildCommandMessage('open'), name: 'shutdown' },
        });
        relay.send({
            source: {},
            origin: 'https://app.example.test',
            data: buildCommandMessage('open'),
        });

        expect(relay.chatFeature.mock.calls).toEqual([['open'], ['close']]);
    });

    it('reports loader status to its parent on its own origin', () => {
        const relay = startRelay();

        expect(relay.parent.postMessage).toHaveBeenCalledWith(
            {
                ns: 'chatfeature-preview',
                v: 1,
                type: 'status',
                loader: 'loading',
                frame: true,
            },
            'https://app.example.test',
        );
    });
});
