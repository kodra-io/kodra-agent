# Deploying the configurator

The configurator is a static site served at `build.kodra.io/agent` (SPEC decision 5). It
lives in the Kodra Build site's S3 bucket under `agent/`, behind the Build site's
CloudFront distribution, and is deployed separately from the Build site.

## What the hosting needs (once)

Kept in Kodra's own infrastructure repos, not here:

1. **The Build site's deploy leaves `agent/` alone.** Its `aws s3 sync --delete` steps end
   with `--exclude "agent/*"` (later filters win, and excluded keys are never deleted).
   Without this, every Build deploy deletes the configurator.
2. **CloudFront behaviors for `/agent` and `/agent/*`** on the Build distribution, with:
   - a viewer-request function: `/agent` redirects to `/agent/`, and `/agent/` and any
     extensionless `/agent/...` path go to `/agent/index.html`. The Build distribution sends
     every missing object to the Build site's own `/index.html`, so without this rewrite
     `/agent/` would show the Build home page;
   - a viewer-response function that adds the configurator's CSP (the same as its meta tag
     in `apps/configurator/vite.config.ts`) plus `frame-ancestors 'none'`, a `DENY` frame
     option, `nosniff`, a `no-referrer` referrer policy, and HSTS. A function, not a
     response headers policy: CloudFront's free flat-rate plan, which the Build
     distributions use, rejects custom response headers policies.

## Publishing a new version

With AWS credentials that can write to the bucket and invalidate the distribution:

```sh
KODRA_AGENT_BUCKET=<bucket> KODRA_AGENT_DISTRIBUTION=<distribution id> \
  scripts/deploy-configurator.sh
```

The script builds the site, uploads the content-hashed files with a one-year cache, then
`index.html` with `no-cache`, and invalidates `/agent*` only. Old hashed files are kept, so a
browser that still has the previous `index.html` keeps working. Deploy to the dev Build site
first, check it, then prod.

## Checking a deploy

- `/agent` redirects to `/agent/`, and the page loads in English and Arabic (right to left).
- The response has the `Content-Security-Policy` header with `connect-src 'none'`.
- The browser's network panel shows no request to any other origin.
- A bundle downloads, and its `kodra-agent.yaml` validates (`kodra-agent doctor`).
- The Build site's home page and its other routes are unchanged.
