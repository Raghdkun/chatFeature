import { describe, expect, it } from 'vite-plus/test';
import {
    displayAttribute,
    humaniseField,
    withFieldLabel,
} from '@/lib/validation-messages';

describe('displayAttribute (what Laravel puts into :attribute)', () => {
    it('keeps dots, snake-cases camelCase and turns underscores into spaces', () => {
        expect(displayAttribute('config.hours.holidays.1.date')).toBe(
            'config.hours.holidays.1.date',
        );
        expect(displayAttribute('config.theme.primaryText')).toBe(
            'config.theme.primary text',
        );
        expect(displayAttribute('idle_timeout_minutes')).toBe(
            'idle timeout minutes',
        );
        expect(displayAttribute('category_ulids.0')).toBe('category ulids.0');
    });
});

describe('humaniseField', () => {
    it('drops config/settings, numbers list positions from 1 and spells out words', () => {
        expect(humaniseField('config.theme.primaryText')).toBe(
            'theme primary text',
        );
        expect(humaniseField('greetings.0.body')).toBe('greetings #1 body');
        expect(humaniseField('config.hours.holidays.1.date')).toBe(
            'hours holidays #2 date',
        );
        expect(humaniseField('settings.idle_timeout_minutes')).toBe(
            'idle timeout minutes',
        );
        expect(humaniseField('name')).toBe('name');
        expect(humaniseField('config')).toBe('config');
    });
});

describe('withFieldLabel', () => {
    it('swaps the dotted attribute of a Laravel message for the label and keeps the rule text', () => {
        expect(
            withFieldLabel(
                'The config.hours.holidays.1.date field has a duplicate value.',
                'config.hours.holidays.1.date',
                'Holiday 2 date',
            ),
        ).toBe('The Holiday 2 date field has a duplicate value.');
    });

    it('also finds the "snake case" spelling of a camelCase key and replaces every mention', () => {
        expect(
            withFieldLabel(
                'The config.theme.primary text field is invalid. config.theme.primary text again.',
                'config.theme.primaryText',
                'Text on primary',
            ),
        ).toBe('The Text on primary field is invalid. Text on primary again.');
        expect(
            withFieldLabel(
                'The category ulids.0 field must be unique.',
                'category_ulids.0',
                'Category 1',
            ),
        ).toBe('The Category 1 field must be unique.');
    });

    it('leaves plain one-word attributes and custom texts alone', () => {
        expect(
            withFieldLabel(
                'The name field is required.',
                'name',
                'Widget name',
            ),
        ).toBe('The name field is required.');
        expect(
            withFieldLabel(
                '"https://x" is not a valid domain.',
                'domains.0',
                'Domain 1',
            ),
        ).toBe('"https://x" is not a valid domain.');
        expect(
            withFieldLabel('Unknown option.', 'config.theme.colour', 'x'),
        ).toBe('Unknown option.');
    });
});
