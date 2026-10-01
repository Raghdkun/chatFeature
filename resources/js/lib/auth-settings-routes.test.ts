import { describe, expect, it } from 'vite-plus/test';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import { setupRoutes } from '@/lib/setup-routes';

describe('authSettingsRoutes', () => {
    it('matches the contract paths', () => {
        expect(authSettingsRoutes.index).toBe('/settings/auth');
        expect(authSettingsRoutes.environment('production')).toBe(
            '/settings/auth/environments/production',
        );
        expect(authSettingsRoutes.environmentTest('testing')).toBe(
            '/settings/auth/environments/testing/test',
        );
        expect(authSettingsRoutes.activeEnvironment).toBe(
            '/settings/auth/active-environment',
        );
        expect(authSettingsRoutes.roles).toBe('/settings/auth/roles');
    });
});

describe('setupRoutes (mode 2)', () => {
    it('adds the Auth Portal endpoints next to the generated ones', () => {
        expect(setupRoutes.pizzasys).toEqual({
            url: '/setup/pizzasys',
            method: 'post',
        });
        expect(setupRoutes.pizzasysTest.url).toBe('/setup/pizzasys/test');
        expect(setupRoutes.portalAdmin.url).toBe('/setup/portal-admin');
    });

    it('keeps the mode-1 endpoints intact', () => {
        expect(setupRoutes.index.url).toBe('/setup');
        expect(setupRoutes.mode.url).toBe('/setup/mode');
        expect(setupRoutes.run('write-lock')).toBe('/setup/run/write-lock');
    });
});
