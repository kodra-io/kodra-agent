import { describe, expect, it } from 'vitest';
import { checkDependencies } from './dependencies.ts';
import { fixtureList } from './test-fixtures.ts';

const ids = (issues: ReturnType<typeof checkDependencies>) => issues.map((i) => i.connector);

describe('checkDependencies', () => {
  it('passes when nothing is enabled', () => {
    expect(checkDependencies(fixtureList, [])).toEqual([]);
  });

  it('flags a category requirement that is not met', () => {
    const issues = checkDependencies(fixtureList, ['ci']);
    expect(ids(issues)).toEqual(['ci']);
    expect(issues[0]?.message.en).toBe('ci needs a source connector');
  });

  it('accepts any connector of the required category', () => {
    expect(checkDependencies(fixtureList, ['ci', 'src'])).toEqual([]);
  });

  it('does not let a connector satisfy its own category requirement', () => {
    // pinned-ci is cicd; ci requires "source", which pinned-ci is not, so ci still fails.
    expect(ids(checkDependencies(fixtureList, ['ci', 'pinned-ci']))).toEqual(['ci', 'pinned-ci']);
  });

  it('flags a specific connector requirement and clears it when that connector is on', () => {
    expect(ids(checkDependencies(fixtureList, ['pinned-ci']))).toEqual(['pinned-ci']);
    expect(checkDependencies(fixtureList, ['pinned-ci', 'src'])).toEqual([]);
  });

  it('ignores unknown ids', () => {
    expect(checkDependencies(fixtureList, ['nope', 'src'])).toEqual([]);
  });
});
