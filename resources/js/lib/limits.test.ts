/**
 * Pins the client limits to the PHP rules they mirror. The values are read from the PHP source
 * (as raw text), so a server-side change that is not followed here fails this test instead of
 * shipping as a form that accepts input the server rejects (or refuses input the server accepts).
 */
import { describe, expect, it } from 'vite-plus/test';
import {
    FONT_FAMILY,
    LIMITS,
    LOCALE_CODE,
    LOCALE_CODE_LENGTH,
    SLUG_PATTERN,
} from '@/lib/limits';

const php = import.meta.glob<string>(
    [
        '/app/Domain/Widgets/Config/WidgetConfigValidator.php',
        '/app/Domain/Catalog/Support/CategorySlugger.php',
        '/app/Http/Requests/Widgets/*.php',
        '/app/Http/Requests/Catalog/StoreCategoryRequest.php',
        '/app/Http/Requests/Agents/*.php',
        '/app/Http/Requests/Auth/UpdateAuthEnvironmentRequest.php',
        '/app/Http/Requests/Auth/UpdateAuthRolesRequest.php',
        '/app/Http/Requests/Setup/SavePizzasysRequest.php',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const source = (name: string): string => {
    const entry = Object.entries(php).find(([path]) => path.endsWith(name));

    if (!entry) {
        throw new Error(`PHP source not found: ${name}`);
    }

    return entry[1];
};

/** The rule list of `'<key>' => [ ... ]` (first match). */
const rule = (file: string, key: string): string => {
    const escaped = key.replace(/[.*]/g, (char) => `\\${char}`);
    const match = new RegExp(`'${escaped}'\\s*=>\\s*\\[([^\\]]*)\\]`).exec(
        source(file),
    );

    if (!match) {
        throw new Error(`rule '${key}' not found in ${file}`);
    }

    return match[1];
};

const between = (file: string, key: string) => {
    const match = /between:(\d+),(\d+)/.exec(rule(file, key));

    if (!match) {
        throw new Error(`no between rule for '${key}' in ${file}`);
    }

    return { min: Number(match[1]), max: Number(match[2]) };
};

const max = (file: string, key: string): number => {
    const match = /\bmax:(\d+)/.exec(rule(file, key));

    if (!match) {
        throw new Error(`no max rule for '${key}' in ${file}`);
    }

    return Number(match[1]);
};

const constant = (file: string, name: string): number => {
    const match = new RegExp(`const ${name}\\s*=\\s*(\\d+);`).exec(
        source(file),
    );

    if (!match) {
        throw new Error(`constant ${name} not found in ${file}`);
    }

    return Number(match[1]);
};

const CONFIG = 'WidgetConfigValidator.php';

describe('widget config ranges (WidgetConfigValidator::rules)', () => {
    it('matches every numeric range of the config', () => {
        expect(LIMITS.radius).toEqual(between(CONFIG, 'theme.radius'));
        expect(LIMITS.panelWidth).toEqual(between(CONFIG, 'theme.panelWidth'));
        expect(LIMITS.panelHeight).toEqual(
            between(CONFIG, 'theme.panelHeight'),
        );
        expect(LIMITS.offset).toEqual(between(CONFIG, 'theme.offsetX'));
        expect(LIMITS.offset).toEqual(between(CONFIG, 'theme.offsetY'));
        expect(LIMITS.zIndex).toEqual(between(CONFIG, 'theme.zIndex'));
        expect(LIMITS.delaySeconds).toEqual(
            between(CONFIG, 'greetings.delaySeconds'),
        );
        expect(LIMITS.intervalMinutes).toEqual(
            between(CONFIG, 'greetings.intervalMinutes'),
        );
        expect(LIMITS.autoHideSeconds).toEqual(
            between(CONFIG, 'greetings.autoHideSeconds'),
        );
        expect(LIMITS.queueTimeoutSeconds).toEqual(
            between(CONFIG, 'routing.queueTimeoutSeconds'),
        );
        expect(LIMITS.idleTimeoutMinutes).toEqual(
            between(CONFIG, 'session.idleTimeoutMinutes'),
        );
    });

    it('matches the lengths and counts of the config', () => {
        expect(LIMITS.fontFamilyLength).toBe(max(CONFIG, 'theme.fontFamily'));
        expect(LIMITS.launcherLabelLength).toBe(max(CONFIG, 'launcher.label'));
        expect(LIMITS.consentLength).toBe(max(CONFIG, 'preChat.consentText'));
        expect(LIMITS.maxScheduleRanges).toBe(max(CONFIG, 'hours.schedule'));
        expect(LIMITS.maxHolidays).toBe(max(CONFIG, 'hours.holidays'));
        expect(LIMITS.holidayLabelLength).toBe(
            max(CONFIG, 'hours.holidays.*.label'),
        );
        expect(LIMITS.maxTextLocales).toBe(constant(CONFIG, 'MAX_LOCALES'));
        // Every text key shares one rule: `$rules['texts.*.'.$key] = ['string', 'max:500']`.
        expect(source(CONFIG)).toContain(
            `'texts.*.'.$key] = ['string', 'max:${LIMITS.textLength}']`,
        );
    });

    it('uses the same locale and font patterns', () => {
        expect(source(CONFIG)).toContain(`'/${LOCALE_CODE.source}/D'`);
        expect(source(CONFIG).replaceAll("\\'", "'")).toContain(
            `'/${FONT_FAMILY.source}/uD'`,
        );
        expect(source('UpdateWidgetRequest.php')).toContain(LOCALE_CODE.source);
        expect(source('ReplaceGreetingsRequest.php')).toContain(
            LOCALE_CODE.source,
        );
        // The longest accepted tag, so inputs can cap their length.
        expect('a'.repeat(3) + '-abcdefgh'.repeat(2)).toHaveLength(
            LOCALE_CODE_LENGTH,
        );
        expect(LOCALE_CODE.test('a'.repeat(3) + '-abcdefgh'.repeat(2))).toBe(
            true,
        );
        expect(LOCALE_CODE.test('en-a-b-c')).toBe(false);
        expect(LOCALE_CODE.test('en-US-x-y')).toBe(false);
    });
});

describe('widget columns (Store/UpdateWidgetRequest)', () => {
    it('matches name and timeouts', () => {
        expect(LIMITS.nameLength).toBe(max('StoreWidgetRequest.php', 'name'));
        expect(LIMITS.nameLength).toBe(max('UpdateWidgetRequest.php', 'name'));
        expect(LIMITS.idleTimeoutMinutes).toEqual(
            between('UpdateWidgetRequest.php', 'idle_timeout_minutes'),
        );
        expect(LIMITS.queueTimeoutSeconds).toEqual(
            between('UpdateWidgetRequest.php', 'queue_timeout_seconds'),
        );
    });
});

describe('greetings and domains', () => {
    const greetings = 'ReplaceGreetingsRequest.php';
    const domains = 'ReplaceDomainsRequest.php';

    it('matches the greeting pool rules', () => {
        expect(LIMITS.maxGreetings).toBe(constant(greetings, 'MAX_GREETINGS'));
        expect(LIMITS.greetingBodyLength).toBe(
            max(greetings, 'greetings.*.body'),
        );
        expect(LIMITS.greetingAgentNameLength).toBe(
            max(greetings, 'greetings.*.agent_name'),
        );
        expect(LIMITS.greetingWeight).toEqual(
            between(greetings, 'greetings.*.weight'),
        );
    });

    it('matches the domain rules', () => {
        expect(LIMITS.maxDomains).toBe(constant(domains, 'MAX_DOMAINS'));
        expect(LIMITS.domainEntryLength).toBe(max(domains, 'domains.*'));
    });
});

describe('categories', () => {
    const category = 'StoreCategoryRequest.php';

    it('matches the category rules', () => {
        expect(LIMITS.categoryNameLength).toBe(max(category, 'name'));
        expect(LIMITS.categoryDescriptionLength).toBe(
            max(category, 'description'),
        );
        expect(LIMITS.categoryIconLength).toBe(max(category, 'icon'));
        expect(LIMITS.maxCategoryTranslations).toBe(max(category, 'name_i18n'));
        expect(LIMITS.categoryNameLength).toBe(max(category, 'name_i18n.*'));
        expect(LIMITS.categorySlugLength).toBe(
            constant('CategorySlugger.php', 'MAX_LENGTH'),
        );
        expect(source('CategorySlugger.php')).toContain(
            `'/${SLUG_PATTERN.source}/D'`,
        );
    });
});

describe('staff', () => {
    it('matches the staff rules', () => {
        expect(LIMITS.maxConcurrentChats).toEqual(
            between('UpdateAgentRequest.php', 'max_concurrent_chats'),
        );
        expect(LIMITS.staffNameLength).toBe(
            max('StoreAgentRequest.php', 'name'),
        );
        expect(LIMITS.staffEmailLength).toBe(
            max('StoreAgentRequest.php', 'email'),
        );
        expect(LIMITS.staffPasswordLength).toBe(
            max('StoreAgentRequest.php', 'password'),
        );
    });
});

describe('auth portal', () => {
    const environment = 'UpdateAuthEnvironmentRequest.php';
    const roles = 'UpdateAuthRolesRequest.php';
    const setup = 'SavePizzasysRequest.php';

    it('matches the environment fields', () => {
        expect(LIMITS.portalLabelLength).toBe(max(environment, 'label'));
        expect(LIMITS.secretLength).toBe(max(environment, 'service_token'));
        expect(LIMITS.secretLength).toBe(max(environment, 'nats_token'));
        expect(source(environment)).toContain(
            `{1,${LIMITS.serviceNameLength}}`,
        );
    });

    it('matches the role mapping, in Settings and in the wizard', () => {
        for (const file of [roles, setup]) {
            expect(LIMITS.permissionLength).toBe(max(file, 'admin_permission'));
            expect(LIMITS.permissionLength).toBe(max(file, 'agent_permission'));
            expect(LIMITS.maxSuperRoles).toBe(max(file, 'super_roles'));
            expect(LIMITS.superRoleLength).toBe(max(file, 'super_roles.*'));
        }
    });
});
