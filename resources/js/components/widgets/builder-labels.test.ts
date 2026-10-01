import { describe, expect, it } from 'vite-plus/test';
import { builderFieldLabel } from '@/components/widgets/builder-labels';
import { createI18n } from '@/lib/i18n';
import { en } from '@/tests/lang';

const translator = createI18n({
    fallbackLocale: 'en',
    bundled: { en },
    loaders: {},
}).translatorFor('en');

const label = (path: string) => builderFieldLabel(path, translator);

describe('builderFieldLabel', () => {
    it('names settings and design fields the way the form does', () => {
        expect(label('settings.idle_timeout_minutes')).toBe('Idle timeout');
        expect(label('settings.name')).toBe('Widget name');
        expect(label('config.theme.primary')).toBe('Primary color');
        expect(label('config.theme.primaryText')).toBe('Text on primary');
        expect(label('config.theme.panelHeight')).toBe('Panel height');
        expect(label('config.launcher.label')).toBe('Label');
        expect(label('config.greetings.delaySeconds')).toBe('Delay');
        expect(label('config.defaultLocale')).toBe('Default language');
        expect(label('config.hours.timezone')).toBe('Time zone');
        expect(label('config.preChat.consentText')).toBe('Consent text');
    });

    it('numbers list items from 1', () => {
        expect(label('config.hours.holidays.1.date')).toBe('Holiday 2 date');
        expect(label('config.hours.holidays.0.label')).toBe('Holiday 1 name');
        expect(label('config.hours.schedule.2.start')).toBe(
            'Hours range 3 opening time',
        );
        expect(label('config.hours.schedule.2.end')).toBe(
            'Hours range 3 closing time',
        );
        expect(label('greetings.0.body')).toBe('Greeting 1: Message');
        expect(label('greetings.3.agent_avatar_url')).toBe(
            'Greeting 4: Agent photo URL',
        );
        expect(label('domains.4')).toBe('Domain 5');
        expect(label('categories.0')).toBe('Category 1');
    });

    it('names texts per language and pre-chat fields', () => {
        expect(label('config.texts.fr.title')).toContain('Panel title');
        expect(label('config.preChat.fields.email.enabled')).toBe(
            'Show Email field',
        );
        expect(label('config.preChat.fields.name.required')).toBe(
            'Require Name field',
        );
        expect(label('config.features.rating')).toBe('Chat rating');
    });

    it('has no label for what it does not know (no leaking raw translation keys)', () => {
        expect(label('config.theme.colour')).toBeUndefined();
        expect(label('config.texts.fr.nonsense')).toBeUndefined();
        expect(label('config.features.nonsense')).toBeUndefined();
        expect(label('config.preChat.fields.fax.enabled')).toBeUndefined();
        expect(label('config.routing.waves.0.afterSeconds')).toBeUndefined();
        expect(label('settings.nonsense')).toBeUndefined();
        expect(label('greetings.x.body')).toBeUndefined();
        expect(label('other.thing')).toBeUndefined();
    });
});
