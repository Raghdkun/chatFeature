import { describe, expect, it } from 'vite-plus/test';
import {
    handoffPreview,
    isPrivateAddress,
    waMeUrl,
} from '@/lib/whatsapp/address';

describe('isPrivateAddress', () => {
    it.each([
        'http://localhost:2785',
        'http://127.0.0.1:2785',
        'http://127.1.2.3',
        'http://10.0.0.5:2785',
        'http://172.16.4.1',
        'http://172.31.255.255',
        'http://192.168.1.20:2785',
        'http://169.254.169.254',
        'http://[::1]:2785',
        'http://[fd12:3456::1]:2785',
        'http://openwa:2785',
        'http://openwa.local',
        'http://wa.internal:2785',
        'http://app.localhost',
    ])('knows %s is the machine itself or a private network', (address) => {
        expect(isPrivateAddress(address)).toBe(true);
    });

    it.each([
        'https://openwa.example.com',
        'https://openwa.example.com:8443/',
        'http://8.8.8.8:2785',
        'http://172.32.0.1',
        'http://172.15.0.1',
        'http://192.169.1.1',
        'http://[2001:db8::1]',
    ])('treats %s as public', (address) => {
        expect(isPrivateAddress(address)).toBe(false);
    });

    it('says nothing about text that is not an address', () => {
        expect(isPrivateAddress('')).toBe(false);
        expect(isPrivateAddress('not a url')).toBe(false);
    });
});

describe('the hand-off text', () => {
    it('fills the code in wherever :code stands', () => {
        expect(handoffPreview('Hi! My support code is :code', 'K7M2QX4P')).toBe(
            'Hi! My support code is K7M2QX4P',
        );
        expect(handoffPreview(':code and :code', 'AB')).toBe('AB and AB');
    });

    it('builds the wa.me link from the digits of the number', () => {
        expect(waMeUrl('+49 170 1234567', 'Hi! Code K7M2QX4P')).toBe(
            'https://wa.me/491701234567?text=Hi!%20Code%20K7M2QX4P',
        );
        expect(waMeUrl('+4915112345678', 'a&b')).toBe(
            'https://wa.me/4915112345678?text=a%26b',
        );
        expect(waMeUrl(null, 'x')).toBeNull();
        expect(waMeUrl('none', 'x')).toBeNull();
    });
});
