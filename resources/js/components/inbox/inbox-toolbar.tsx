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

/** Mute / unmute the inbox sounds (remembered per browser). Unmuting is a user gesture, so it also unlocks the audio context. */
export function SoundToggle({ sound }: { sound: SoundPlayer }) {
    const { t } = useTrans();
    const muted = useSyncExternalStore(
        sound.subscribe,
        sound.isMuted,
        () => false,
    );

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="sound-toggle"
            aria-pressed={!muted}
            aria-label={muted ? t('inbox.sound.unmute') : t('inbox.sound.mute')}
            title={muted ? t('inbox.sound.unmute') : t('inbox.sound.mute')}
            onClick={() => {
                sound.unlock();
                sound.setMuted(!muted);
            }}
        >
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
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
