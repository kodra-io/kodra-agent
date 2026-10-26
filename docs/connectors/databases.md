# Databases connector

**Server:** none outside the agent. A built-in MCP server (`runtime: builtin`, module
`databases`) runs inside the agent process, connected to the host over an in-memory link.
**Decided:** 2026-10-21
**Status:** preview. It works but is less tested than the stable connectors, and may change. It is off by default and listed under "More connectors" in the configurator and the console.

Watches the databases you list, wherever they run: a standalone server, a cloud database
(Amazon RDS or Aurora, Azure Database, Cloud SQL), or one in Kubernetes. MariaDB, MySQL, and
PostgreSQL, directly or through an SSH tunnel. Health checks only.

## Why built in, not an MCP server

| Option                                                                   | Why not, or why                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MCP Toolbox for Databases](https://github.com/googleapis/genai-toolbox) | Apache-2.0 and broad, but its tools are bound to one database each, so tool names would differ per configured database, and the host blocks every tool its manifest does not list by name. Its prebuilt configs offer `execute_sql`. A large binary. |
| Engine-specific MCP servers                                              | One server per engine, most offer free SQL, and none tunnels.                                                                                                                                                                                        |
| **Built in (chosen)**                                                    | Two fixed tools whatever is configured, so the manifest classifies them. The queries are hard-coded: no tool takes SQL. A tunnel hands its channel to the driver directly, so no local port opens.                                                   |

The built-in server goes through the same host as every other connector: its tools are
classified in the manifest, guarded, redacted, audited when the model calls them, and blocked
if unclassified.

### Dependencies (pinned)

| Package       | Version | Why                                                                                                                                                       |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mysql2`      | 3.24.5  | MariaDB and MySQL driver, MIT, active. The previous release, because the newest was days old.                                                             |
| `pg`          | 8.23.1  | PostgreSQL driver, MIT, active.                                                                                                                           |
| `ssh2`        | 1.17.0  | SSH client for tunnels, MIT, pure JavaScript. Its optional native add-ons are not built (`allowBuilds` in `pnpm-workspace.yaml`): no install script runs. |
| `@types/pg`   | 8.23.1  | Types only (dev).                                                                                                                                         |
| `@types/ssh2` | 1.15.6  | Types only (dev).                                                                                                                                         |

SQL Server comes next (its driver, `tedious`, pulls in the Azure SDK, so it gets its own
review). Oracle later.

## Tools

| Tool              | Risk | What it does                                                                                                                                                             |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_databases`  | read | The configured databases: name, engine, host, port, database, TLS mode, and how it connects. No connection, never a secret.                                              |
| `database_health` | read | Connects to one database by name and reads its status: version, uptime, connections in use of the maximum, read-only, a replica's lag, and a state (ok, degraded, down). |

**Guard:** `database_health`'s `database` must be one of the configured names
(`arg-in-setting` over the `databases` entries). Nothing else can be reached.

The queries, by engine (fixed; a failed optional query leaves its field empty):

- **MariaDB, MySQL:** `SELECT VERSION(), @@read_only, @@max_connections`;
  `SHOW GLOBAL STATUS` for `Uptime` and `Threads_connected`; `SHOW REPLICA STATUS` (or
  `SHOW SLAVE STATUS` on older servers).
- **PostgreSQL:** `server_version`, `pg_is_in_recovery()`, `max_connections`,
  `default_transaction_read_only`, and uptime from `pg_postmaster_start_time()`; the count of
  `pg_stat_activity`; on a replica, replay lag (zero when caught up) and whether the WAL
  receiver is streaming.

**State:** down when it does not answer (with the reason in plain words: refused, host not
found, user or password refused, certificate not verified, tunnel host key changed); degraded
when connections reach `connectionsWarnPercent` of the maximum (default 90), a replica is more
than `maxLagSeconds` behind (default 30), or replication stopped; else ok. Driver error
messages are never passed on.

## Settings

`databases` is a list of entries (at most 20), each with:

| Field                                     | Notes                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`                                    | Lowercase letters, digits, and hyphens. What tools, the console, and alerts call it.                             |
| `engine`                                  | `mariadb`, `mysql`, or `postgres`.                                                                               |
| `host`, `port`, `database`, `user`        | The port defaults to 3306 or 5432; PostgreSQL connects to `postgres` when `database` is empty.                   |
| `password`                                | A secret reference: `${env:KODRA_DB_<NAME>_PASSWORD}`, or a `${file:...}`.                                       |
| `tls`                                     | `verify` (default: encrypted, certificate checked against `host`), `require` (encrypted, not checked), or `off`. |
| `tunnelHost`, `tunnelPort`, `tunnelUser`  | An SSH bastion to connect through; the port defaults to 22.                                                      |
| `tunnelHostKey`                           | The bastion's host key fingerprint, `SHA256:...`. Required with a tunnel.                                        |
| `tunnelKey`                               | The private key, as a secret reference: `${env:KODRA_DB_<NAME>_TUNNEL_KEY}`.                                     |
| `maxLagSeconds`, `connectionsWarnPercent` | When the database counts as degraded.                                                                            |

**A database's secrets are named for it.** An `${env:...}` reference must be that entry's own
variable (`KODRA_DB_ORDERS_PASSWORD` for `orders`); the schema refuses any other, so an entry
can never be pointed at another connector's secret (the model key, say) and send it to a host
of someone's choosing. The console always writes these names itself and never accepts a
reference from the browser; a `${file:...}` reference already in the file is kept. A database
pointed at a new host or tunnel shows as new access in the console's review.

Add databases in the configurator, which never asks for a password: it writes each database's
references and lists its variables in `.env.example`. `kodra-agent init` then asks for each one
with hidden input and tests it against that database alone (a tunnelled database once its
tunnel key is entered too). Or add them later in the console (**Settings → Connectors →
Databases**), then enter each password under **Secrets**: it is tested against that database
before it is saved, and another database being down does not block it. Or edit
`kodra-agent.yaml` and `.env` by hand.

## The database user

Give the agent a user that can read status and nothing else:

```sql
-- MariaDB 10.5 or newer
CREATE USER 'kodra_monitor'@'%' IDENTIFIED BY '...';
GRANT REPLICA MONITOR ON *.* TO 'kodra_monitor'@'%';   -- only for replica lag

-- MySQL
CREATE USER 'kodra_monitor'@'%' IDENTIFIED BY '...';
GRANT REPLICATION CLIENT ON *.* TO 'kodra_monitor'@'%'; -- only for replica lag

-- PostgreSQL
CREATE ROLE kodra_monitor LOGIN PASSWORD '...';
GRANT pg_monitor TO kodra_monitor;
```

Without the replication grant, everything but replica lag still works.

## SSH tunnels

The agent opens the tunnel itself (`ssh2`), and only a forwarded channel to the database: no
shell, no exec, no agent or X11 forwarding, no password or keyboard sign-in. The channel is the
driver's socket, so nothing listens on a local port.

The bastion's host key must match `tunnelHostKey`, or the tunnel is refused before signing in
(there is no trust on first use). Get it from a machine you trust:

```
ssh-keyscan -t ed25519 bastion.example.com | ssh-keygen -lf -
```

Use a key made only for this, and limit it on the bastion to forwarding to that database:

```
restrict,port-forwarding,permitopen="orders.internal:3306" ssh-ed25519 AAAA... kodra-agent
```

The private key must not have a passphrase (the agent cannot type one); keep it in the
`.env` variable or a file with owner-only permissions.

## TLS

`verify` checks the server certificate against the system CAs plus any you add under
`spec.network` ([networks](../network.md)). Amazon RDS uses its own CA: add the
[RDS bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html) as a
CA, or set `tls: require` to encrypt without checking. Through a tunnel, the certificate is
still checked against `host`.

## Dashboard and Overview

The **Databases** card calls `database_health` for each entry, through the same policy check,
and shows its state, version, connections, a replica's lag, and why it is not ok. Overview
counts these with the Kubernetes connector's databases (`namespace/name`, from their pods)
in **Databases ready**, gives each a light under Systems, and puts one that is down or degraded
in the attention queue.

## Testing

- `src/databases/tunnel.test.ts`: a real SSH server in the test process (host key pinning,
  key refusal, forwarding, no sessions asked for).
- `src/databases/databases.e2e.test.ts`: real MariaDB and PostgreSQL, directly and through a
  tunnel, the connector through the host and the policy, and the console saving a password
  only after it connects. CI runs them as services. Locally:

```
docker run -d --rm --name kodra-test-mariadb -e MARIADB_ROOT_PASSWORD=root-test \
  -e MARIADB_USER=kodra_monitor -e MARIADB_PASSWORD=monitor-test -p 127.0.0.1:13306:3306 mariadb:11.4
docker run -d --rm --name kodra-test-postgres -e POSTGRES_PASSWORD=pg-test -p 127.0.0.1:15432:5432 postgres:16
KODRA_DB_E2E=1 KODRA_DB_E2E_MARIADB_PASSWORD=monitor-test KODRA_DB_E2E_POSTGRES_PASSWORD=pg-test \
  pnpm exec vitest run apps/agent/src/databases
```
