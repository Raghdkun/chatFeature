import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export type Theme = 'light' | 'dark';

/**
 * Switch the colour scheme of the open page. The app follows the system preference
 * (`appearance` = system), so emulating the media feature flips the `dark` class live.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
    await page.emulateMedia({ colorScheme: theme });

    const html = page.locator('html');

    if (theme === 'dark') {
        await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    } else {
        await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    }

    await settle(page);
}

/**
 * No horizontal scrolling: the document is never wider than the viewport (neither the layout
 * viewport reported by the page nor the viewport the test asked for).
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
    const viewportWidth = page.viewportSize()?.width ?? Infinity;

    await expect
        .poll(
            () =>
                page.evaluate(
                    (limit) =>
                        document.documentElement.scrollWidth -
                        Math.min(window.innerWidth, limit),
                    viewportWidth,
                ),
            { message: 'document.documentElement.scrollWidth <= innerWidth' },
        )
        .toBeLessThanOrEqual(0);
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** axe's own best-practice rules are reported (attached) but do not fail the test. */
const REPORTED_TAGS = [...WCAG_TAGS, 'best-practice'];
const isWcagRule = (tags: string[]) =>
    tags.some((tag) => tag.startsWith('wcag'));

/**
 * Run axe on the current page. `serious` and `critical` violations of WCAG A/AA rules fail the
 * test; everything else (milder impact, axe best-practice rules) is attached to the report as
 * `axe-<label>` JSON and never silently dropped.
 */
export async function expectNoSeriousA11yViolations(
    page: Page,
    testInfo: TestInfo,
    label: string,
): Promise<void> {
    // Entry animations (fade-in) and theme transitions change the measured colours.
    await settle(page);

    const results = await new AxeBuilder({ page })
        .withTags(REPORTED_TAGS)
        .analyze();

    const describe = (violation: (typeof results.violations)[number]) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({
            target: node.target.join(' '),
            html: node.html.slice(0, 160),
            data: node.any.map((check) => check.data),
        })),
    });

    await testInfo.attach(`axe-${label}`, {
        body: JSON.stringify(results.violations.map(describe), null, 2),
        contentType: 'application/json',
    });

    expect(
        results.violations
            .filter(
                (violation) =>
                    isWcagRule(violation.tags) &&
                    (violation.impact === 'serious' ||
                        violation.impact === 'critical'),
            )
            .map(describe),
        `axe serious/critical violations on ${label}`,
    ).toEqual([]);
}

/**
 * Wait for web fonts and every finite CSS transition/animation (they last 150-300ms). Colours
 * measured mid-transition would give false contrast failures and blurry screenshots. A
 * transition only starts on the frame after a style change, hence the two animation frames
 * before looking. Endless animations (skeleton pulse, spinners) are ignored.
 */
export async function settle(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await document.fonts.ready;

        const nextFrame = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
            );

        for (let pass = 0; pass < 5; pass++) {
            await nextFrame();
            await nextFrame();

            const running = document
                .getAnimations()
                .filter(
                    (animation) =>
                        animation.effect?.getComputedTiming().iterations !==
                        Infinity,
                );

            if (running.length === 0) {
                return;
            }

            await Promise.all(
                running.map((animation) =>
                    animation.finished.catch(() => undefined),
                ),
            );
        }
    });
}
