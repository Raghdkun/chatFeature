import { useEffect, useState } from 'react';
import { useWaApi } from '@/lib/realtime/whatsapp/context';

/**
 * `whatsapp.reply_only_to_inbound`, which the inbox page does not carry: read once, the first time a chat is open, so the composer can
 * say "the customer has to write first" before the administrator types a reply the API would refuse (`409 reply_not_allowed`).
 * `undefined` until known and when the read fails: then the API alone decides, which is always correct.
 */
export function useReplyOnlyToInbound(enabled: boolean): boolean | undefined {
    const api = useWaApi();
    const [value, setValue] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        if (!enabled || value !== undefined) {
            return;
        }

        let cancelled = false;

        api.settings()
            .then((settings) => {
                if (!cancelled) {
                    setValue(settings.replyOnlyToInbound);
                }
            })
            .catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [api, enabled, value]);

    return value;
}
