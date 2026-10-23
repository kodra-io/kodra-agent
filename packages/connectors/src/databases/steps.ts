import type { SetupStep } from '@kodra-agent/schema';

/** How to get each database's values (M28); placeholders are the entry's own fields. */

export const PASSWORD_STEPS: SetupStep[] = [
  {
    text: 'Connect to the database as an admin and create a user that can only read server status. Pick a new password for it. MariaDB 10.5 or newer:',
    run: {
      all: `CREATE USER '{{user}}'@'%' IDENTIFIED BY '<new password>';
GRANT REPLICA MONITOR ON *.* TO '{{user}}'@'%';`,
    },
  },
  {
    text: 'MySQL:',
    run: {
      all: `CREATE USER '{{user}}'@'%' IDENTIFIED BY '<new password>';
GRANT REPLICATION CLIENT ON *.* TO '{{user}}'@'%';`,
    },
  },
  {
    text: 'PostgreSQL:',
    run: {
      all: `CREATE ROLE {{user}} LOGIN PASSWORD '<new password>';
GRANT pg_monitor TO {{user}};`,
    },
  },
  {
    text: 'Enter that password here. It is tested against this database before it is saved. Without the replication grant, everything but replica lag still works.',
  },
];

export const TUNNEL_KEY_STEPS: SetupStep[] = [
  {
    text: 'Make a key only for this. Press Enter twice when it asks for a passphrase: the agent cannot type one.',
    run: { all: 'ssh-keygen -t ed25519 -C kodra-agent -f kodra-agent-tunnel' },
  },
  {
    text: 'Allow the key on the bastion for forwarding to this database only (use the database port, like 3306 or 5432). This uses your own SSH access to the bastion.',
    run: {
      linux: `echo "restrict,port-forwarding,permitopen=\\"{{host}}:{{port}}\\" $(cat kodra-agent-tunnel.pub)" | ssh -p {{tunnelPort}} {{tunnelUser}}@{{tunnelHost}} 'cat >> ~/.ssh/authorized_keys'`,
      macos: `echo "restrict,port-forwarding,permitopen=\\"{{host}}:{{port}}\\" $(cat kodra-agent-tunnel.pub)" | ssh -p {{tunnelPort}} {{tunnelUser}}@{{tunnelHost}} 'cat >> ~/.ssh/authorized_keys'`,
      windows:
        '"restrict,port-forwarding,permitopen=`"{{host}}:{{port}}`" $(Get-Content kodra-agent-tunnel.pub)" | ssh -p {{tunnelPort}} {{tunnelUser}}@{{tunnelHost}} \'cat >> ~/.ssh/authorized_keys\'',
    },
  },
  { text: 'Upload kodra-agent-tunnel here (the private key, not the .pub file).' },
];

export const HOST_KEY_STEPS: SetupStep[] = [
  {
    text: 'From a machine that has signed in to the bastion before, read the fingerprint it trusted (with a port other than 22, look up [{{tunnelHost}}]:{{tunnelPort}}):',
    run: { all: 'ssh-keygen -l -F {{tunnelHost}}' },
  },
  {
    text: 'Or ask the bastion for its key, and compare the result with what its admin sees in /etc/ssh/ssh_host_ed25519_key.pub before you trust it:',
    run: { all: 'ssh-keyscan -t ed25519 -p {{tunnelPort}} {{tunnelHost}} | ssh-keygen -lf -' },
  },
  { text: 'Enter the SHA256:… value. The tunnel is refused when the bastion shows another key.' },
];

/** Amazon RDS signs with its own CA. */
export const HOST_STEPS: SetupStep[] = [
  {
    text: 'On Amazon RDS with Encryption set to verify, the agent needs Amazon’s CA. Save it in the bundle folder under ca/, then set network.caBundleFile to /etc/kodra-agent/ca/rds-global-bundle.pem in kodra-agent.yaml. Or set Encryption to require.',
    run: {
      linux:
        'mkdir -p ca && curl -fsSL -o ca/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
      macos:
        'mkdir -p ca && curl -fsSL -o ca/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
      windows:
        'New-Item -ItemType Directory -Force ca | Out-Null; Invoke-WebRequest -UseBasicParsing -OutFile ca\\rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
    },
  },
];
