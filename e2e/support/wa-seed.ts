/**
 * A WhatsApp inbox worth looking at, for the view specs (axe, 375 / 320 px, Arabic, keyboard) and the deck pictures: a connected session and a
 * few customers: an unread chat, a linked chat with a visitor and a topic, a conversation with a stored picture, a document card, a link,
 * replies at every stage of delivery (pending is not shown: it passes in a blink) and one that failed, an archived chat.
 * Everything goes through the real API and the mock, never the database, so what the pages show is what the product made of it.
 */
import type { Api } from './api';
import type { OpenWaMock } from './openwa';
import type { Instance } from './scenarios';
import { asBase64, smallPng } from './wa-images';
import { linkedChat, whatsappWidget, type WhatsAppWidget } from './wa-flow';
import {
    readySession,
    transcript,
    uniquePhone,
    waitForChat,
    waitForMessage,
    type TestSession,
} from './wa-test';
import { data, type WaAdminApi, type WaChat, type WaMessage } from './whatsapp';

export type Inbox = {
    session: TestSession;
    widget: WhatsAppWidget;
    /** The conversation the specs open: text, a picture, a document, a link, replies (sent / delivered / read) and a failed one. */
    main: WaChat & {
        customer: string;
        messages: WaMessage[];
        pictureUlid: string;
        failedUlid: string;
    };
    /** Linked to the widget, the topic and a named visitor. */
    linked: WaChat & { customer: string };
    /** One unread message. */
    unread: WaChat & { customer: string };
    archived: WaChat & { customer: string };
};

export async function seedInbox(
    adminApi: Api,
    wa: WaAdminApi,
    openWa: OpenWaMock,
    instance: Instance,
    options: { names?: boolean } = {},
): Promise<Inbox> {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const mock = (await openWa.state()).sessions.find(
        (candidate) => candidate.name === session.name,
    )!;
    const sendPath = `/api/sessions/${mock.id}/messages/send-text`;
    const customer = uniquePhone();
    const names = options.names !== false;

    // The main conversation.
    await openWa.inboundText(
        session.name,
        customer,
        'Hello! I ordered a pair of shoes last week and the box arrived damaged.',
        { pushName: names ? 'Maya Haddad' : undefined },
    );
    await openWa.inbound(session.name, {
        from: customer,
        type: 'image',
        body: 'This is how it looks',
        pushName: names ? 'Maya Haddad' : undefined,
        media: {
            mimetype: 'image/png',
            filename: 'box.png',
            dataBase64: asBase64(smallPng(72)),
        },
    });
    await openWa.inbound(session.name, {
        from: customer,
        type: 'document',
        body: 'And the invoice, if you need it',
        pushName: names ? 'Maya Haddad' : undefined,
        media: {
            mimetype: 'application/pdf',
            filename: 'invoice-48213.pdf',
            sizeBytes: 48_128,
            omitted: true,
            stored: false,
        },
    });
    await openWa.inboundText(
        session.name,
        customer,
        'Details are on https://example.com/orders/48213 if that helps.',
        { pushName: names ? 'Maya Haddad' : undefined },
    );

    const main = await waitForChat(wa, session, customer);

    await waitForMessage(
        wa,
        main,
        (message) =>
            message.type === 'image' &&
            (message as unknown as { media: { available: boolean } }).media
                .available,
        'the picture',
    );
    await waitForMessage(wa, main, (message) =>
        (message.body ?? '').startsWith('Details are on'),
    );

    // Replies at three stages: sent, delivered, read; then one OpenWA refuses.
    await openWa.sessionAcks(session.name, { mode: 'manual' });

    const send = async (text: string, ack: 'sent' | 'delivered' | 'read') => {
        data(await wa.reply(main.ulid, text), 'reply');

        const call = await openWa.waitForRequest(
            (request) =>
                request.path === sendPath &&
                JSON.stringify(request.body).includes(text),
        );

        if (ack !== 'sent') {
            await openWa.ack(
                session.name,
                (call.response as { messageId: string }).messageId,
                'delivered',
            );
        }

        if (ack === 'read') {
            await openWa.ack(
                session.name,
                (call.response as { messageId: string }).messageId,
                'read',
            );
        }

        await waitForMessage(
            wa,
            main,
            (message) =>
                message.body === text &&
                message.status === (ack === 'sent' ? 'sent' : ack),
        );
    };

    await send(
        'So sorry about that, Maya. Could you send a photo of the label?',
        'read',
    );
    await send('I have opened a replacement for you.', 'delivered');
    await send('It ships tomorrow morning.', 'sent');
    await openWa.script({
        method: 'POST',
        path: sendPath,
        status: 400,
        body: { statusCode: 400, message: 'Bad Request' },
    });
    data(
        await wa.reply(main.ulid, 'Here is your tracking number: 48213-TRK'),
        'reply',
    );

    const failed = await waitForMessage(
        wa,
        main,
        (message) =>
            message.body === 'Here is your tracking number: 48213-TRK' &&
            message.status === 'failed',
        'the failed reply',
    );
    const messages = await transcript(wa, main);
    const picture = messages.find((message) => message.type === 'image')!;

    // The other chats.
    const unreadPhone = uniquePhone();

    await openWa.inboundText(
        session.name,
        unreadPhone,
        'Do you ship to Amman?',
        { pushName: names ? 'Omar Nasser' : undefined },
    );

    const archivedPhone = uniquePhone();

    await openWa.inboundText(
        session.name,
        archivedPhone,
        'Thanks, all sorted!',
        { pushName: names ? 'Rana Said' : undefined },
    );

    const linkedResult = await linkedChat(
        openWa,
        wa,
        instance,
        session,
        widget,
        {
            name: names ? 'Vera Visitor' : 'Visitor',
            email: 'vera@example.test',
            category: 'billing',
            pushName: names ? 'Vera Visitor' : undefined,
        },
    );
    const unread = await waitForChat(wa, session, unreadPhone);
    const archived = await waitForChat(wa, session, archivedPhone);

    expectOk(await wa.markRead(main.ulid));
    expectOk(await wa.markRead(archived.ulid));
    expectOk(
        await wa.api.post(`/api/v1/whatsapp/chats/${archived.ulid}/archive`),
    );

    return {
        session,
        widget,
        main: {
            ...main,
            customer,
            messages,
            pictureUlid: picture.ulid,
            failedUlid: failed.ulid,
        },
        linked: { ...linkedResult.chat, customer: linkedResult.customer },
        unread: { ...unread, customer: unreadPhone },
        archived: { ...archived, customer: archivedPhone },
    };
}

function expectOk(result: { ok: boolean; status: number }): void {
    if (!result.ok) {
        throw new Error(`The seed call failed: HTTP ${result.status}`);
    }
}
