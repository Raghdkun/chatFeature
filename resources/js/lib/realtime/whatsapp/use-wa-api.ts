import { useContext } from 'react';
import { WaRealtimeContext } from '@/lib/realtime/whatsapp/context';
import { waApi, type WaApi } from '@/lib/whatsapp-api/client';

/**
 * The API client of the WhatsApp screens: the provider's (a test may inject a double), else the shared one. Its own module so that the
 * client itself stays out of the dashboard's initial bundle: only the WhatsApp pages and the builder's tab import it.
 */
export function useWaApi(): WaApi {
    return useContext(WaRealtimeContext)?.api ?? waApi;
}
