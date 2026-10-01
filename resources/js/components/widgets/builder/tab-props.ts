import type { Dispatch } from 'react';
import type {
    BuilderAction,
    BuilderState,
} from '@/components/widgets/builder-state';

/** What every builder tab gets: the state to read and the dispatcher to edit it. */
export type TabProps = {
    state: BuilderState;
    dispatch: Dispatch<BuilderAction>;
};
