import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { secretFileName, secretParts, secretShapeProblem, usesAwsExec } from './secret-files.ts';

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - name: prod
    cluster:
      server: https://203.0.113.10:6443
contexts:
  - name: kodra-agent
    context: { cluster: prod, user: kodra-agent }
current-context: kodra-agent
users:
  - name: kodra-agent
    user:
      token: kubeconfig-c4n4ry-token-0123456789
`;

const EKS = `apiVersion: v1
kind: Config
clusters:
  - name: eks
    cluster: { server: 'https://ABC.gr7.us-east-1.eks.amazonaws.com' }
contexts:
  - name: eks
    context: { cluster: eks, user: eks }
current-context: eks
users:
  - name: eks
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: [--region, us-east-1, eks, get-token, --cluster-name, prod]
`;

describe('file secrets', () => {
  it('takes a kubeconfig with a current context, and says plainly what is wrong with others', () => {
    expect(secretShapeProblem('kubeconfig', KUBECONFIG)).toBeNull();
    // What broke a real setup: a kubeconfig with no current-context.
    expect(
      secretShapeProblem('kubeconfig', KUBECONFIG.replace('current-context: kodra-agent\n', '')),
    ).toBe('the kubeconfig has no current-context; set one with kubectl config use-context');
    expect(
      secretShapeProblem(
        'kubeconfig',
        KUBECONFIG.replace('current-context: kodra-agent', 'current-context: x'),
      ),
    ).toBe("the kubeconfig's current-context is not one of its contexts");
    expect(secretShapeProblem('kubeconfig', 'just a token')).toBe(
      'that is not a kubeconfig (it has no clusters)',
    );
    expect(secretShapeProblem('kubeconfig', 'a: [')).toBe(
      'that is not a kubeconfig (it is not YAML)',
    );
    expect(secretShapeProblem('kubeconfig', `${KUBECONFIG}#${'x'.repeat(50_000)}`)).toBe(
      'that file is too big',
    );
  });

  it('takes an SSH private key without a passphrase only, and never quotes it', () => {
    const plain = ssh2.utils.generateKeyPairSync('ed25519');
    expect(secretShapeProblem('ssh-private-key', plain.private)).toBeNull();
    expect(secretShapeProblem('ssh-private-key', plain.public)).toBe(
      'that is not an SSH private key (upload the file without .pub)',
    );
    const locked = ssh2.utils.generateKeyPairSync('ed25519', {
      passphrase: 'pass-c4n4ry',
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    expect(secretShapeProblem('ssh-private-key', locked.private)).toBe(
      'that key has a passphrase; the agent cannot type one',
    );
    const broken = plain.private.replace(/\n[A-Za-z0-9+/=]{20,}\n/, '\nnot-base64!\n');
    expect(secretShapeProblem('ssh-private-key', broken)).toBe(
      'that SSH private key could not be read',
    );
  });

  it("gives the redactor an SSH key's body lines, and finds EKS kubeconfigs", () => {
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    const parts = secretParts('ssh-private-key', key);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => key.includes(p) && !p.startsWith('-----'))).toBe(true);
    expect(secretParts('kubeconfig', KUBECONFIG)).toEqual([]);
    expect(usesAwsExec(EKS)).toBe(true);
    expect(usesAwsExec(EKS.replace('command: aws', 'command: /usr/local/bin/aws'))).toBe(true);
    expect(usesAwsExec(EKS.replace('command: aws', 'command: gke-gcloud-auth-plugin'))).toBe(false);
    expect(usesAwsExec(KUBECONFIG)).toBe(false);
  });

  it('names the file for the connector and the secret', () => {
    expect(secretFileName('kubernetes', 'kubeconfig')).toBe('kubernetes-kubeconfig');
    expect(secretFileName('databases', 'orders-replica.tunnelKey')).toBe(
      'databases-orders-replica-tunnel-key',
    );
  });
});
