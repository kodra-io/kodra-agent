import { describe, expect, it } from 'vitest';
import ar from './locales/ar.json';
import en from './locales/en.json';

describe('console locales', () => {
  it('has the same messages in English and Arabic, with the same placeholders', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders(ar[key as keyof typeof ar]), key).toEqual(placeholders(text));
    }
  });

  it('uses no em dashes', () => {
    expect(JSON.stringify([en, ar])).not.toMatch(/—/);
  });
});
