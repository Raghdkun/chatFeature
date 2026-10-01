import { request } from '@playwright/test';
import { must, VisitorApi } from '../support/chat-api';
import { expect, soloChat, test } from '../support/chat-flows';
import {
    animatedGif,
    garbageAsJpeg,
    htmlAsPng,
    oversizedPng,
    rasterImage,
    stillGif,
    svg,
} from '../support/images';
import { expectEventually } from '../support/wait';

/**
 * Images in a chat, both ways, through the real panel and the real inbox: JPEG, PNG and WebP (and a still GIF) upload with previews,
 * arrive as thumbnails that open in a lightbox, and are served from signed URLs. SVG, scripts or text disguised as pictures, an
 * animated GIF, a file over the size limit and a sixth picture are refused with a message that says why, and nothing is sent.
 * Each test is its own isolated team (`soloChat()`).
 */
test.use({ scenario: 'p4-chat' });
// Several browsers per test, and the machine also runs other suites: the per-test budget is generous (a test takes 3-12 s on a quiet machine).
test.setTimeout(120_000);

type StoredAttachment = {
    ulid: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    url: string;
    thumbUrl: string | null;
};

type StoredMessage = {
    sender: { type: string };
    body: string | null;
    attachments: StoredAttachment[];
};

test('the visitor sends a JPEG, a PNG and a WebP in one message: previews while staged, thumbnails on both sides, a lightbox with the full picture', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid, visitor } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const files = [
        await rasterImage(visitor.page, 'image/jpeg', 800, 600),
        await rasterImage(visitor.page, 'image/png', 640, 480),
        await rasterImage(visitor.page, 'image/webp', 1024, 512),
    ];

    await panel.tid('composer-file').setInputFiles(files);

    // Every file shows a preview chip and becomes ready once uploaded (the send button waits for them).
    const chips = panel.tid('composer-attachment');

    await expect(chips).toHaveCount(3);
    await expect(
        chips.and(panel.frame.locator('[data-status="ready"]')),
    ).toHaveCount(3);
    await panel.composerInput.fill('Three photos of the damaged box');
    await panel.tid('composer-send').click();

    // The visitor's own bubble: three thumbnails (320 px at most), loaded.
    const sent = panel.message('Three photos', 'visitor');

    await expect(sent.getByTestId('message-image')).toHaveCount(3);
    await expect(sent.locator('img')).toHaveCount(3);

    for (const image of await sent.locator('img').all()) {
        await expect
            .poll(() =>
                image.evaluate((node: HTMLImageElement) => node.naturalWidth),
            )
            .toBeGreaterThan(0);
        expect(
            await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
        ).toBeLessThanOrEqual(320);
    }

    // The agent's inbox has the same three, from the same message.
    await agent.inbox.expectMessage('Three photos');

    const attachments = agent.inbox
        .message('Three photos')
        .first()
        .locator('[data-testid^="attachment-"]');

    await expect(attachments).toHaveCount(3);

    for (const image of await attachments.locator('img').all()) {
        await expect
            .poll(() =>
                image.evaluate((node: HTMLImageElement) => node.naturalWidth),
            )
            .toBeGreaterThan(0);
    }

    // What is stored: three attachments of the right types, signed URLs, and nothing that identifies a disk path or a file hash.
    const stored = await expectEventually(
        async () =>
            must<StoredMessage[]>(
                await agent.api.messages(ulid),
                'the stored messages',
            ).find((message) => message.sender.type === 'visitor'),
        (message) => (message?.attachments.length ?? 0) === 3,
        { message: 'the message carries its three pictures' },
    );

    expect(stored!.body).toBe('Three photos of the damaged box');
    // The pictures keep the order the visitor picked them in (JPEG, PNG, WebP), not the order the uploads happened to finish in ...
    expect(stored!.attachments.map((item) => item.mime)).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
    ]);
    // ... in the dashboard too.
    expect(
        await attachments.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-testid')),
        ),
    ).toEqual(stored!.attachments.map((item) => `attachment-${item.ulid}`));

    for (const attachment of stored!.attachments) {
        expect(Object.keys(attachment).sort()).toEqual([
            'height',
            'mime',
            'size',
            'thumbUrl',
            'ulid',
            'url',
            'width',
        ]);
        expect(attachment.url).toContain('signature=');
        expect(attachment.thumbUrl).toContain('thumb=1');
    }

    // The signed URL works without any login and is served as an inert image; a tampered signature is refused.
    const anonymous = await request.newContext();
    // The JPEG (800 px wide) is the first picture.
    const jpegIndex = stored!.attachments.findIndex(
        (item) => item.mime === 'image/jpeg',
    );
    const first = stored!.attachments[jpegIndex];
    const full = await anonymous.get(first.url);

    expect(full.status()).toBe(200);
    expect(full.headers()['content-type']).toBe('image/jpeg');
    expect(full.headers()['x-content-type-options']).toBe('nosniff');
    expect(full.headers()['content-security-policy']).toContain(
        "default-src 'none'",
    );

    const thumb = await anonymous.get(first.thumbUrl!);

    expect(thumb.status()).toBe(200);
    expect((await thumb.body()).length).toBeLessThan(
        (await full.body()).length,
    );
    expect(
        (
            await anonymous.get(
                first.url.replace(/signature=[^&]+/, 'signature=0000'),
            )
        ).status(),
    ).toBe(403);
    await anonymous.dispose();

    // The lightbox on the visitor's side shows the full picture (800 px wide) and closes with its button and with Escape.
    await sent.getByTestId('message-image').nth(jpegIndex).click();

    const lightbox = panel.tid('lightbox');

    await expect(lightbox).toBeVisible();
    await expect
        .poll(() =>
            lightbox
                .locator('img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBe(800);
    await panel.tid('lightbox-close').click();
    await expect(lightbox).toHaveCount(0);
    await sent.getByTestId('message-image').nth(jpegIndex).click();
    await expect(lightbox).toBeVisible();
    await visitor.page.keyboard.press('Escape');
    await panel.frame.locator('body').press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(panel.root).toBeVisible();

    // And in the dashboard.
    await attachments.first().click();
    await expect(agent.inbox.tid('lightbox')).toBeVisible();
    await agent.page.keyboard.press('Escape');
    await expect(agent.inbox.tid('lightbox')).toHaveCount(0);
});

test('the agent sends a picture to the visitor: staged in the composer, thumbnail and lightbox in the panel', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, visitor } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const picture = await rasterImage(agent.page, 'image/png', 900, 700);

    await agent.inbox.tid('composer-file').setInputFiles(picture);

    const chip = agent.inbox
        .tid('composer-attachments')
        .locator('[data-status]');

    await expect(chip).toHaveAttribute('data-status', 'ready');
    await agent.inbox.composerInput.fill('This is the product you ordered');
    await agent.inbox.tid('composer-send').click();

    const received = panel.message('This is the product', 'agent');

    await expect(received.getByTestId('message-image')).toHaveCount(1);
    await expect
        .poll(() =>
            received
                .locator('img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBeGreaterThan(0);

    await received.getByTestId('message-image').click();
    await expect(panel.tid('lightbox')).toBeVisible();
    await expect
        .poll(() =>
            panel
                .tid('lightbox')
                .locator('img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBe(900);
    await panel.tid('lightbox-close').click();

    // A picture alone, without a caption, is a message too; the same on a still GIF.
    await agent.inbox
        .tid('composer-file')
        .setInputFiles(stillGif('sticker.gif'));
    await expect(
        agent.inbox
            .tid('composer-attachments')
            .locator('[data-status="ready"]'),
    ).toHaveCount(1);
    await agent.inbox.tid('composer-send').click();
    await expect(
        panel.messageList.locator(
            '[data-sender="agent"] [data-testid="message-image"]',
        ),
    ).toHaveCount(2);
    expect(
        await visitor.page.evaluate(() => (window as any).__pwned),
    ).toBeUndefined();
});

test('files that are not safe pictures are refused with a clear message and nothing is sent: SVG, text or HTML dressed as a picture, an animated GIF, a file over the size limit, a sixth picture', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid, visitor } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const input = panel.tid('composer-file');
    const alert = panel.frame.getByRole('alert');
    const chips = panel.tid('composer-attachment');

    // Refused by the panel before anything is uploaded (declared type, size).
    await input.setInputFiles(svg('logo.svg'));
    await expect(alert).toContainText(
        'Only JPEG, PNG, WebP and GIF images can be sent.',
    );
    await expect(chips).toHaveCount(0);

    await input.setInputFiles(oversizedPng(6 * 1024 * 1024));
    await expect(alert).toContainText('Images must be 5 MB or smaller.');
    await expect(chips).toHaveCount(0);

    // Dressed as pictures, they get through the panel's precheck and the server judges the content: each one is refused and its chip
    // says so; the visitor removes it.
    for (const disguised of [
        svg('photo.png', 'image/png'),
        htmlAsPng('invoice.png'),
        garbageAsJpeg('holiday.jpg'),
        animatedGif('funny.gif'),
    ]) {
        visitor.watch.allow(/422/);
        await input.setInputFiles(disguised);
        await expect(chips).toHaveCount(1);
        await expect(chips).toHaveAttribute('data-status', 'error');
        await expect(alert).toContainText(
            "That image can't be sent. Try a smaller JPEG, PNG, WebP or GIF.",
        );
        await panel.tid('composer-attachment-remove').click();
        await expect(chips).toHaveCount(0);
    }

    // Six at once: the first five are accepted, the sixth is refused with the count.
    const pictures = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
            rasterImage(
                visitor.page,
                'image/jpeg',
                64,
                64,
                `small-${index + 1}.jpg`,
            ),
        ),
    );

    await input.setInputFiles(pictures);
    await expect(alert).toContainText('You can attach up to 5 images.');
    await expect(chips).toHaveCount(5);
    await expect(
        chips.and(panel.frame.locator('[data-status="ready"]')),
    ).toHaveCount(5);

    for (let index = 0; index < 5; index += 1) {
        await panel.tid('composer-attachment-remove').first().click();
    }

    await expect(chips).toHaveCount(0);

    // Nothing was ever sent: the conversation has no visitor message and the send button is dead without text.
    await expect(panel.tid('composer-send')).toBeDisabled();
    expect(
        must<StoredMessage[]>(
            await agent.api.messages(ulid),
            'the stored messages',
        ).filter((message) => message.sender.type === 'visitor'),
    ).toEqual([]);
});

test('the server refuses what the panel would let through, with the field that is at fault: type by content, animated GIF, size, dimensions', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { panel, ulid, visitor } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const api = await VisitorApi.withToken(
        instance,
        (await panel.visitorToken())!,
        visitor.address,
    );
    const picture = await rasterImage(visitor.page, 'image/jpeg', 200, 100);

    // A good picture is accepted (the control that proves the refusals are about the files).
    const accepted = await api.upload(ulid, picture);

    expect(accepted.status).toBe(201);
    expect(accepted.data).toMatchObject({
        mime: 'image/jpeg',
        width: 200,
        height: 100,
    });

    for (const [name, file] of [
        ['svg', svg('a.png', 'image/png')],
        ['html', htmlAsPng('b.png')],
        ['text', garbageAsJpeg('c.jpg')],
        ['animated gif', animatedGif('d.gif')],
        ['oversize', oversizedPng(6 * 1024 * 1024, 'e.png')],
    ] as const) {
        const refused = await api.upload(ulid, file);

        expect(refused.status, `${name} is refused`).toBe(422);
        expect(refused.error?.code, `${name}: the envelope`).toBe(
            'validation_failed',
        );
        expect(
            Object.keys(refused.error?.details ?? {}),
            `${name}: names the file field`,
        ).toContain('file');
    }

    await api.dispose();
});
