# Deploying the configurator

The configurator is a static site served at `build.kodra.io/agent` (SPEC decision 5). It
lives in the Kodra Build site's S3 bucket under `agent/`, behind the Build site's
CloudFront distribution, and is deployed separately from the Build site.

## What the hosting needs (once)

Kept in Kodra's own infrastructure repos, not here. The two CloudFront functions are in the
terraform repo, `Modules/cloudfront/functions/` (`agent-configurator-rewrite.js` and
`agent-configurator-headers.js`):

1. **The Build site's deploy leaves `agent/` alone.** Its `aws s3 sync --delete` steps end
   with `--exclude "agent/*"` (later filters win, and excluded keys are never deleted).
   Without this, every Build deploy deletes the configurator.
2. **CloudFront behaviors for `/agent` and `/agent/*`** on the Build distribution, with:
   - a viewer-request function: `/agent` redirects to `/agent/`, and `/agent/` and any
     extensionless `/agent/...` path go to `/agent/index.html`. The Build distribution sends
     every missing object to the Build site's own `/index.html`, so without this rewrite
     `/agent/` would show the Build home page;
   - a viewer-response function that adds the configurator's CSP (the same as its meta tag,
     `CONTENT_SECURITY_POLICY` in `apps/configurator/src/csp.ts`) plus `frame-ancestors 'none'`, a `DENY` frame
     option, `nosniff`, a `no-referrer` referrer policy, and HSTS. A function, not a
     response headers policy: CloudFront's free flat-rate plan, which the Build
     distributions use, rejects custom response headers policies.

## Publishing a new version

The Build site's GitLab pipeline publishes the configurator (`kodra-build-frontend`,
`.gitlab-ci.yml`, jobs `deploy_agent` and `deploy_agent_prod`), on the same runner and with the
same buckets, distributions, and CI variables as the Build site:

1. Set `KODRA_AGENT_REF` in that `.gitlab-ci.yml` to the tag (or commit) of this repo to
   publish, in a merge request to `main`.
2. When it merges, `deploy_agent` publishes to the dev Build site (`build.dev.kodra.io/agent`).
   Run `pnpm check:deploy https://build.dev.kodra.io` from a checkout of this repo.
3. Run the manual `deploy_agent_prod` job, then `pnpm check:deploy https://build.kodra.io`.

Both jobs fetch this repo at `KODRA_AGENT_REF`, install with pnpm from the lockfile, and run
`scripts/deploy-configurator.sh`: it builds the site, uploads the content-hashed files with a
one-year cache, then `index.html` with `no-cache`, and invalidates `/agent*` only. Old hashed
files are kept, so a browser that still has the previous `index.html` keeps working. The
runner needs Node 22.12 or newer and `git`.

The same script works by hand in an emergency, with AWS credentials that can write to the
bucket and invalidate the distribution:

```sh
KODRA_AGENT_BUCKET=<bucket> KODRA_AGENT_DISTRIBUTION=<distribution id>   scripts/deploy-configurator.sh
```

## Checking a deploy

After every deploy, dev first, then prod:

```sh
pnpm check:deploy https://build.dev.kodra.io
pnpm check:deploy https://build.kodra.io
```

It exits non-zero when any check fails, and says which:

- `/agent` redirects to `/agent/`, and the page loads.
- The `Content-Security-Policy` header is exactly `HEADER_CONTENT_SECURITY_POLICY` from
  `apps/configurator/src/csp.ts` (the build's policy plus `frame-ancestors 'none'`), so a
  change on either side shows up here. Also `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, and HSTS.
- In a browser: no request to any other origin and no console error, then a starter setup
  goes through the steps and downloads a bundle whose `kodra-agent.yaml` validates.
- The Build site's home page still answers, and is not the configurator.

The checker is tested against a stand-in for the Build site
(`apps/configurator/e2e/deploy-check.spec.ts`).
