import { describe, expect, it } from 'vitest';
import en from './locales/en.json';

describe('console locales', () => {
  it('has no empty messages', () => {
    for (const [key, text] of Object.entries(en)) expect(text.trim(), key).not.toBe('');
  });

  it('uses no em dashes', () => {
    expect(JSON.stringify(en)).not.toMatch(/—/);
  });
});
