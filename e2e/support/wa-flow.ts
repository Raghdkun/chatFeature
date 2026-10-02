/**
 * The website side of a WhatsApp hand-off without a browser, for specs that need a LINKED chat as their starting point: a widget that offers
 * WhatsApp (feature on, published, a `ready` session linked), a visitor who asks for the hand-off over the public API (what the panel's
 * "Continue on WhatsApp" calls), and the customer's first WhatsApp message with the code (through the OpenWA mock). The panel itself is driven
 * by `handoff.spec.ts`.
 */
import type { Api } from './api';
import { createWidget } from './api';
import { VisitorApi } from './chat-api';
import type { OpenWaMock } from './openwa';
import type { Instance } from './scenarios';
import { P4_CATEGORIES } from './users';
import {
    uniqueName,
    uniquePhone,
    waitForChat,
    type TestSession,
} from './wa-test';
import { data, type WaAdminApi, type WaChat } from './whatsapp';

export type WhatsAppWidget = { ulid: string; key: string; name: string };

/** A published, enabled widget with the WhatsApp channel on, linked to `session` (the seeded categories, open around the clock). */
export async function whatsappWidget(
    adminApi: Api,
    wa: WaAdminApi,
    instance: Instance,
    session: Pick<TestSession, 'ulid'> | null,
    options: {
        name?: string;
        /** `features.whatsapp` of the published design (default on). */
        feature?: boolean;
        /** Category slugs the widget offers (default all three of the chat seed). */
        categories?: string[];
        config?: Record<string, unknown>;
        settings?: Record<string, unknown>;
    } = {},
): Promise<WhatsAppWidget> {
    const name = options.name ?? uniqueName('Shop');
    const widget = await createWidget(adminApi, {
        name,
        domains: [`localhost:${instance.hostPort}`],
        categories: options.categories ?? P4_CATEGORIES.map((c) => c.slug),
        settings: { offline_mode: 'always_online', ...options.settings },
        config: {
            hours: { mode: 'always_online' },
            greetings: { enabled: false },
            features: { whatsapp: options.feature ?? true },
            ...options.config,
        },
    });

    if (session !== null) {
        data(await wa.linkWidget(widget.ulid, session.ulid), 'link the widget');
    }

    return { ulid: widget.ulid, key: widget.key, name };
}

export type Handoff = { code: string; waUrl: string; expiresAt: string };

/** A visitor of the widget asks for the hand-off (the call behind "Continue on WhatsApp"). */
export async function requestHandoff(
    instance: Instance,
    widget: Pick<WhatsAppWidget, 'key'>,
    options: {
        name?: string;
        email?: string;
        category?: string;
        address?: string;
    } = {},
): Promise<{ visitor: VisitorApi; handoff: Handoff }> {
    const visitor = await VisitorApi.start(instance, {
        key: widget.key,
        address: options.address,
        visitor: {
            name: options.name ?? 'Vera Visitor',
            ...(options.email ? { email: options.email } : {}),
        },
    });
    const result = await visitor.request(
        'POST',
        `/widgets/${widget.key}/whatsapp-handoff`,
        options.category ? { category: options.category } : {},
    );

    if (!result.ok) {
        await visitor.dispose();

        throw new Error(
            `The hand-off failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
        );
    }

    return { visitor, handoff: result.data as Handoff };
}

/**
 * A chat that is linked to a widget, a visitor and a topic: the visitor's code arrives in the customer's first WhatsApp message.
 * The visitor session stays open (dispose it with `visitor.dispose()` or let the test end).
 */
export async function linkedChat(
    openWa: OpenWaMock,
    wa: WaAdminApi,
    instance: Instance,
    session: TestSession,
    widget: WhatsAppWidget,
    options: {
        name?: string;
        email?: string;
        category?: string;
        customer?: string;
        pushName?: string;
        text?: (code: string) => string;
    } = {},
): Promise<{
    chat: WaChat;
    customer: string;
    handoff: Handoff;
    visitor: VisitorApi;
}> {
    const { visitor, handoff } = await requestHandoff(
        instance,
        widget,
        options,
    );
    const customer = options.customer ?? uniquePhone();

    await openWa.inboundText(
        session.name,
        customer,
        options.text?.(handoff.code) ??
            `Hi! My support code is ${handoff.code}`,
        { pushName: options.pushName ?? options.name ?? 'Vera Visitor' },
    );

    const chat = await waitForChat(wa, session, customer, { linked: '1' });

    return { chat, customer, handoff, visitor };
}
