#!/usr/bin/env node
import password from '@inquirer/password';
import { createInterface } from 'node:readline/promises';
import { main } from './cli.ts';
import { jsonLogger, redactingTerminal, type Prompter } from './io.ts';
import { realKubernetes } from './kubernetes.ts';
import { Redactor } from './redactor.ts';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

const prompter: Prompter = {
  // mask: false shows nothing at all while typing, not even the length.
  secret: (message) => password({ message, mask: false }),
  text: (message) => ask(message),
  async choice(message, options) {
    process.stderr.write(`${message}\n`);
    options.forEach((o, i) => process.stderr.write(`  ${String(i + 1)}. ${o.label}\n`));
    for (;;) {
      const picked = options[Number((await ask(`Choose 1-${String(options.length)}:`)).trim()) - 1];
      if (picked) return picked.value;
    }
  },
  async confirm(message, defaultValue) {
    const answer = (await ask(`${message} ${defaultValue ? '[Y/n]' : '[y/N]'}`))
      .trim()
      .toLowerCase();
    return answer === '' ? defaultValue : answer.startsWith('y');
  },
};

// Every value that leaves this process goes through one redactor.
const redactor = new Redactor();
const interactive = process.stdin.isTTY && process.stderr.isTTY;

process.exitCode = await main(process.argv.slice(2), {
  term: redactingTerminal({ stdout: process.stdout, stderr: process.stderr }, redactor),
  log: jsonLogger((line) => process.stderr.write(`${line}\n`), redactor),
  redactor,
  prompter: interactive ? prompter : null,
  env: process.env,
  fetch: globalThis.fetch,
  kubernetes: realKubernetes,
  platform: process.platform,
  probeTimeoutMs: 10_000,
});
