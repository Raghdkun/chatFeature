import { Users, Volume2, VolumeX } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { PresenceDot } from '@/components/inbox/presence-select';
import { Button } from '@/components/ui/button';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { useTrans } from '@/hooks/use-trans';
import type { PresenceMemberData } from '@/lib/chat/types';
import type { SoundPlayer } from '@/lib/realtime/staff/sound';

/**
 * Mute / unmute the inbox sounds (remembered per browser). Until the first click or key press the browser keeps the page silent, so a
 * dot says so ("click anywhere") instead of letting the first request go unheard. Unmuting is a gesture too, so it unlocks the audio.
 */
export function SoundToggle({ sound }: { sound: SoundPlayer }) {
    const { t } = useTrans();
    const state = useSyncExternalStore(
        sound.subscribe,
        sound.state,
        () => 'on' as const,
    );
    // A toggle keeps ONE name and says its state with `aria-pressed`; what a click would do goes in the tooltip.
    const action =
        state === 'muted'
            ? t('inbox.sound.unmute')
            : state === 'locked'
              ? t('inbox.sound.locked')
              : t('inbox.sound.mute');

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="sound-toggle"
            data-state={state}
            aria-pressed={state !== 'muted'}
            aria-label={t('inbox.sound.label')}
            title={action}
            className="relative"
            onClick={() => {
                sound.unlock();

                // A click on a locked toggle is the gesture the browser was waiting for: it turns the sound on, it does not mute.
                if (state !== 'locked') {
                    sound.setMuted(state !== 'muted');
                }
            }}
        >
            {state === 'muted' ? (
                <VolumeX aria-hidden />
            ) : (
                <Volume2 aria-hidden />
            )}
            {state === 'locked' && (
                <span
                    aria-hidden
                    className="absolute end-1.5 top-1.5 size-2 rounded-full bg-amber-500"
                />
            )}
        </Button>
    );
}

/** Who else is signed in (the `presence-staff` roster): a count that opens the list. Hidden when the websocket gave no roster. */
export function RosterPopover({
    roster,
    viewerId,
}: {
    roster: PresenceMemberData[];
    viewerId: number;
}) {
    const { t } = useTrans();
    const others = roster.filter((member) => member.id !== viewerId);

    if (roster.length === 0) {
        return null;
    }

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="roster-toggle"
                    aria-label={t('inbox.roster.label', {
                        count: others.length,
                    })}
                    className="gap-1.5 px-2 text-muted-foreground tabular-nums"
                >
                    <Users aria-hidden />
                    {others.length}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-2">
                <p className="px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {t('inbox.roster.title')}
                </p>
                {others.length === 0 ? (
                    <p className="px-2 py-2 text-sm text-muted-foreground">
                        {t('inbox.roster.empty')}
                    </p>
                ) : (
                    <ul data-testid="roster-list" className="grid gap-0.5">
                        {others.map((member) => (
                            <li
                                key={member.id}
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                            >
                                <PresenceDot status={member.status} />
                                <span className="min-w-0 flex-1 truncate">
                                    {member.name}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {t(`inbox.presence.${member.status}`)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
}
