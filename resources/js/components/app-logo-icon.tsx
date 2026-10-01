import type { SVGAttributes } from 'react';

/** PNE Chat mark: a speech bubble with three typing dots cut out of it. */
export default function AppLogoIcon(props: SVGAttributes<SVGElement>) {
    return (
        <svg {...props} viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M11 5h18a8 8 0 0 1 8 8v7a8 8 0 0 1-8 8H20l-8 7v-7h-1a8 8 0 0 1-8-8v-7a8 8 0 0 1 8-8zm3 9.5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zm6 0a2 2 0 1 0 0 4a2 2 0 1 0 0-4zm6 0a2 2 0 1 0 0 4a2 2 0 1 0 0-4z"
            />
        </svg>
    );
}
