import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'connectors',
    environment: 'node',
  },
});
