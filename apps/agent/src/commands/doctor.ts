import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditLog } from '../audit.ts';
import { components, loadConfig, secretLabel } from '../config.ts';
import type { Context } from '../context.ts';
import { parseEnvFile } from '../env-file.ts';
import { probeIds, runProbe, type ProbeStatus } from '../probes.ts';
import { resolveAll } from '../secrets.ts';

export interface DoctorOptions {
  configPath: string;
  json: boolean;
}

export interface DoctorRow {
  status: ProbeStatus;
  component: string;
  check: string;
  message: string;
  hint?: string;
}

export async function doctor(opts: DoctorOptions, ctx: Context): Promise<number> {
  const rows: DoctorRow[] = [];
  const add = (row: DoctorRow) => rows.push(row);

  const loaded = await loadConfig(opts.configPath);
  if (!loaded.ok) {
    add({
      status: 'fail',
      component: 'config',
      check: 'kodra-agent.yaml',
      message: 'invalid',
      hint: loaded.errors.join('\n'),
    });
    return finish(rows, opts, ctx);
  }
  const { config, dir } = loaded;
  add({
    status: 'pass',
    component: 'config',
    check: 'kodra-agent.yaml',
    message: `valid (${config.apiVersion})`,
  });

  // Inside the container compose already loads .env; outside it, read it too.
  const envPath = join(dir, '.env');
  const envText = await readOptional(envPath);
  const dotenv = envText === null ? {} : Object.fromEntries(parseEnvFile(envText));
  const env = { ...dotenv, ...ctx.env };

  const audit = new AuditLog(config.spec.audit.path, ctx.redactor);
  const auditOk = await audit
    .append({ event: 'task.start', actor: 'cli', task: 'doctor' })
    .then(() => true)
    .catch(() => false);
  add(
    auditOk
      ? {
          status: 'pass',
          component: 'audit',
          check: 'audit log',
          message: `writable at ${audit.path}`,
        }
      : {
          status: 'fail',
          component: 'audit',
          check: 'audit log',
          message: `cannot write ${audit.path}`,
          hint: 'The agent needs this path writable. In compose it is a named volume; check spec.audit.path.',
        },
  );

  if (envText !== null) add(await envPermissions(envPath, ctx));

  for (const comp of components(config)) {
    const { values, missing } = await resolveAll(comp.secrets, { env, redactor: ctx.redactor });
    for (const use of comp.secrets) {
      const gap = missing.find((m) => m.use === use);
      add(
        gap
          ? {
              status: use.spec.required ? 'fail' : 'skip',
              component: comp.displayName,
              check: secretLabel(use),
              message: gap.reason,
              ...(use.spec.required ? { hint: 'Run `kodra-agent init` to set it.' } : {}),
            }
          : {
              status: 'pass',
              component: comp.displayName,
              check: secretLabel(use),
              message: 'set',
            },
      );
    }
    for (const id of probeIds(comp)) {
      const needed = comp.secrets.filter((s) => s.spec.probe === id && s.spec.required);
      if (needed.some((s) => missing.some((m) => m.use === s))) {
        add({ status: 'skip', component: comp.displayName, check: id, message: 'secret missing' });
        continue;
      }
      const result = await runProbe(id, {
        component: comp,
        secrets: values,
        fetch: ctx.fetch,
        kubernetes: ctx.kubernetes,
        timeoutMs: ctx.probeTimeoutMs,
        ...(ctx.endpoints ? { endpoints: ctx.endpoints } : {}),
      });
      add({ component: comp.displayName, check: id, ...result });
    }
    if (comp.secrets.length === 0 && probeIds(comp).length === 0) {
      add({
        status: 'skip',
        component: comp.displayName,
        check: 'connectivity',
        message: 'no separate check; it uses another connector’s access',
      });
    }
  }

  const code = finish(rows, opts, ctx);
  if (auditOk) {
    const count = (status: ProbeStatus) => String(rows.filter((r) => r.status === status).length);
    await audit
      .append({
        event: 'result',
        actor: 'cli',
        task: 'doctor',
        detail: `${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`,
      })
      .catch(() => undefined);
  }
  return code;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function envPermissions(path: string, ctx: Context): Promise<DoctorRow> {
  if (ctx.platform === 'win32') {
    return {
      status: 'skip',
      component: 'secrets',
      check: '.env permissions',
      message: 'not checked on Windows, which does not use Unix file modes',
    };
  }
  const mode = (await stat(path)).mode & 0o777;
  return mode & 0o077
    ? {
        status: 'fail',
        component: 'secrets',
        check: '.env permissions',
        message: `mode ${mode.toString(8)}: other users can read it`,
        hint: `chmod 600 ${path}`,
      }
    : {
        status: 'pass',
        component: 'secrets',
        check: '.env permissions',
        message: 'owner-only (600)',
      };
}

const LABEL: Record<ProbeStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

function finish(rows: readonly DoctorRow[], opts: DoctorOptions, ctx: Context): number {
  const failed = rows.filter((r) => r.status === 'fail');
  if (opts.json) {
    ctx.term.out(JSON.stringify({ ok: failed.length === 0, checks: rows }, null, 2));
  } else {
    const width = (key: 'component' | 'check') =>
      Math.max(...rows.map((r) => r[key].length), key.length);
    const cw = width('component');
    const kw = width('check');
    ctx.term.out(`STATUS  ${'COMPONENT'.padEnd(cw)}  ${'CHECK'.padEnd(kw)}  DETAILS`);
    for (const r of rows) {
      ctx.term.out(
        `${LABEL[r.status].padEnd(6)}  ${r.component.padEnd(cw)}  ${r.check.padEnd(kw)}  ${r.message}`,
      );
    }
    if (failed.length > 0) {
      ctx.term.out('');
      ctx.term.out('How to fix:');
      for (const r of failed) {
        ctx.term.out(`- ${r.component} / ${r.check}: ${r.hint ?? r.message}`);
      }
    }
    const passed = rows.filter((r) => r.status === 'pass').length;
    const skipped = rows.length - passed - failed.length;
    ctx.term.out('');
    ctx.term.out(
      `${String(passed)} passed, ${String(failed.length)} failed, ${String(skipped)} skipped.`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}
