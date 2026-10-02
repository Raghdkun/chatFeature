import { useTrans } from '@/hooks/use-trans';
import { formatCount } from '@/lib/analytics/format';

/**
 * A 2px trend line with an end dot, as an image with a text alternative ("Trend: from 4 to 9, peak 12"): the same numbers are in the table
 * row it sits in, so nothing depends on seeing it.
 */
export function Sparkline({
    values,
    width = 84,
    height = 24,
}: {
    values: number[];
    width?: number;
    height?: number;
}) {
    const { t, locale } = useTrans();

    if (values.length === 0) {
        return null;
    }

    const max = Math.max(...values);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const pad = 3;
    const x = (index: number) =>
        values.length === 1
            ? width / 2
            : pad + (index * (width - pad * 2)) / (values.length - 1);
    const y = (value: number) =>
        height - pad - ((value - min) / span) * (height - pad * 2);
    const points = values
        .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
        .join(' ');
    const last = values.length - 1;

    return (
        <svg
            role="img"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-label={t('analytics.sparkline', {
                first: formatCount(values[0], locale),
                last: formatCount(values[last], locale),
                peak: formatCount(max, locale),
            })}
            className="inline-block align-middle"
        >
            <polyline
                points={points}
                fill="none"
                stroke="var(--series-1)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle
                cx={x(last)}
                cy={y(values[last])}
                r={3}
                fill="var(--series-1)"
                stroke="var(--card)"
                strokeWidth={2}
            />
        </svg>
    );
}
