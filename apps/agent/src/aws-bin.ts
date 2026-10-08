#!/usr/bin/env node
import { awsShim } from './eks-token.ts';

// `aws eks get-token` for EKS kubeconfigs (docker/aws runs this). The exec-plugin protocol
// needs the ExecCredential, a short-lived token, on stdout; errors go to stderr.
process.exitCode = await awsShim(
  process.argv.slice(2),
  { env: process.env },
  (text) => process.stdout.write(`${text}\n`),
  (text) => process.stderr.write(`${text}\n`),
);
