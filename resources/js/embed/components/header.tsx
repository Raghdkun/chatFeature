import { useController, useEnv, useSnapshot } from '@/embed/components/context';
import { X } from '@/embed/components/icons';
import { Avatar, IconButton } from '@/embed/components/ui';

/** Title (or the agent, once there is one), "End chat" while chatting, and the close button. */
export function Header({ onEndChat }: { onEndChat: () => void }) {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const env = useEnv();
    const agent =
        state.phase === 'active' || state.phase === 'ended'
            ? state.conversation?.agent
            : null;
    const canEnd =
        state.phase === 'active' && config?.features.endChatByVisitor === true;

    return (
        <header className="pne-header">
            {agent ? (
                <span className="bg-on-brand/15 rounded-full p-0.5">
                    <Avatar name={agent.name} url={agent.avatarUrl} size={40} />
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <h1 className="truncate text-[17px] leading-tight font-semibold">
                    {agent ? agent.name : t('title')}
                </h1>
                <p className="truncate text-[13px] opacity-85">
                    {agent ? t('title') : t('subtitle')}
                </p>
            </div>
            {canEnd ? (
                <button
                    type="button"
                    data-testid="end-chat"
                    onClick={onEndChat}
                    disabled={state.busy === 'ending'}
                    className="pne-press pne-focus pne-hover-dim min-h-10 shrink-0 rounded-md px-3 text-[13px] font-semibold disabled:opacity-60"
                >
                    {t('endChat')}
                </button>
            ) : null}
            {env.hasHost ? (
                <IconButton
                    label={t('closeChat')}
                    onClick={() => controller.requestClose()}
                >
                    <X aria-hidden="true" className="size-5" />
                </IconButton>
            ) : null}
        </header>
    );
}
