/**
 * Every length / range / pattern the dashboard enforces on the client, in one table.
 *
 * The PHP rules are the authority; these only keep the inputs inside them so an obvious mistake
 * never costs a round trip. When a server rule changes, change it here too (the PHP source of each
 * group is named next to it). `limits.test.ts` pins the values to the PHP rules.
 */
import { IDLE_TIMEOUT } from '@/lib/setup-flow';

export type Range = { min: number; max: number };

export const LIMITS = {
    /* Widget columns: app/Http/Requests/Widgets/{Store,Update}WidgetRequest.php */
    nameLength: 120,
    idleTimeoutMinutes: {
        min: IDLE_TIMEOUT.min,
        max: IDLE_TIMEOUT.max,
    } as Range,
    queueTimeoutSeconds: { min: 15, max: 600 } as Range,

    /* Widget config: app/Domain/Widgets/Config/WidgetConfigValidator.php::rules() */
    radius: { min: 0, max: 28 } as Range,
    panelWidth: { min: 280, max: 600 } as Range,
    panelHeight: { min: 360, max: 900 } as Range,
    offset: { min: 0, max: 200 } as Range,
    zIndex: { min: 1, max: 2147483647 } as Range,
    fontFamilyLength: 200,
    launcherLabelLength: 40,
    textLength: 500,
    maxTextLocales: 20,
    consentLength: 500,
    delaySeconds: { min: 0, max: 600 } as Range,
    intervalMinutes: { min: 1, max: 1440 } as Range,
    autoHideSeconds: { min: 3, max: 3600 } as Range,
    maxScheduleRanges: 42,
    maxHolidays: 400,
    holidayLabelLength: 80,

    /* Greeting pool: app/Http/Requests/Widgets/ReplaceGreetingsRequest.php */
    maxGreetings: 100,
    greetingBodyLength: 2000,
    greetingWeight: { min: 1, max: 100 } as Range,
    greetingAgentNameLength: 120,

    /* Domains: app/Http/Requests/Widgets/ReplaceDomainsRequest.php */
    maxDomains: 50,
    domainEntryLength: 255,

    /* Categories: app/Http/Requests/Catalog/StoreCategoryRequest.php + Domain/Catalog/Support/CategorySlugger.php */
    categoryNameLength: 120,
    categorySlugLength: 64,
    categoryDescriptionLength: 1000,
    categoryIconLength: 64,
    maxCategoryTranslations: 20,

    /* Setup basics: app/Http/Requests/Setup/StoreBasicsRequest.php */
    appNameLength: 100,
    appUrlLength: 255,

    /* Staff: app/Http/Requests/Agents/{Store,Update}AgentRequest.php */
    maxConcurrentChats: { min: 1, max: 50 } as Range,
    staffNameLength: 255,
    staffEmailLength: 255,
    staffPasswordLength: 255,

    /* Auth portal: app/Http/Requests/Auth/Update*Request.php + Setup/SavePizzasysRequest.php */
    portalLabelLength: 64,
    serviceNameLength: 64,
    secretLength: 512,
    permissionLength: 128,
    superRoleLength: 64,
    maxSuperRoles: 20,
} as const;

/**
 * BCP 47-ish language tag: `en`, `ar`, `pt-BR`, `zh-Hant-TW` (at most two subtags after the
 * language). Same pattern as the PHP `LOCALE` constants (WidgetConfigValidator, UpdateWidgetRequest,
 * ReplaceGreetingsRequest).
 */
export const LOCALE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/** Longest string `LOCALE_CODE` accepts (3 + two `-xxxxxxxx` subtags). */
export const LOCALE_CODE_LENGTH = 21;

/** Letters, digits, spaces and the punctuation of a CSS font stack (WidgetConfigValidator::FONT_FAMILY). */
export const FONT_FAMILY = /^[\p{L}\p{N} ,'"._-]+$/u;

/** Category slugs: lower-case words joined by single hyphens (CategorySlugger::PATTERN). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
