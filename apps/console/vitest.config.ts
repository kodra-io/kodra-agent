import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'console',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
