import { describe, expect, it } from 'vitest';
import { templateIds } from './index.ts';

describe('templates', () => {
  it('has no templates yet', () => {
    expect(templateIds).toEqual([]);
  });
});
