import { describedBy, Field } from '@/components/setup/field';
import { NativeSelect } from '@/components/setup/native-select';
import { i18n } from '@/hooks/use-trans';
import { localeLabel } from '@/lib/i18n';
import {
    canonicalTimeZone,
    formatTimeZone,
    getTimeZones,
    groupTimeZones,
} from '@/lib/timezones';
import { LOCALE_SUGGESTIONS } from '@/lib/widget-config';

/** Locales worth offering: the app's own, the common widget languages and whatever is already used. */
export function localeOptions(extra: string[] = []): string[] {
    return [
        ...new Set([
            ...i18n.availableLocales(),
            ...LOCALE_SUGGESTIONS,
            ...extra,
        ]),
    ].sort();
}

export function LocaleSelect({
    id,
    label,
    value,
    onValueChange,
    extra,
    hint,
    error,
    allowAny,
    anyLabel,
}: {
    id: string;
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    extra?: string[];
    hint?: string;
    error?: string;
    /** Adds an empty option (used by greetings: "any language"). */
    allowAny?: boolean;
    anyLabel?: string;
}) {
    return (
        <Field id={id} label={label} hint={hint} error={error}>
            <NativeSelect
                id={id}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(id, { hint, error })}
            >
                {allowAny && <option value="">{anyLabel}</option>}
                {localeOptions([
                    ...(extra ?? []),
                    ...(value ? [value] : []),
                ]).map((code) => (
                    <option key={code} value={code}>
                        {localeLabel(code)}
                    </option>
                ))}
            </NativeSelect>
        </Field>
    );
}

export function TimeZoneSelect({
    id,
    label,
    value,
    onValueChange,
    hint,
    error,
}: {
    id: string;
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    hint?: string;
    error?: string;
}) {
    // A saved legacy name (Asia/Calcutta) is shown, and from then on sent, under its canonical name.
    const current = canonicalTimeZone(value);
    const groups = groupTimeZones(getTimeZones(current));

    return (
        <Field id={id} label={label} hint={hint} error={error}>
            <NativeSelect
                id={id}
                value={current}
                onChange={(event) => onValueChange(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(id, { hint, error })}
            >
                {groups.map((group) =>
                    group.region === 'Other' ? (
                        group.zones.map((zone) => (
                            <option key={zone} value={zone}>
                                {zone}
                            </option>
                        ))
                    ) : (
                        <optgroup key={group.region} label={group.region}>
                            {group.zones.map((zone) => (
                                <option key={zone} value={zone}>
                                    {formatTimeZone(zone)}
                                </option>
                            ))}
                        </optgroup>
                    ),
                )}
            </NativeSelect>
        </Field>
    );
}
