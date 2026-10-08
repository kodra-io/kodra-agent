#!/usr/bin/env sh
# Builds the configurator and publishes it to <bucket>/agent/ behind CloudFront.
# See docs/configurator-deploy.md. The bucket and distribution are passed in, never stored here:
#
#   KODRA_AGENT_BUCKET=<bucket> KODRA_AGENT_DISTRIBUTION=<distribution id> scripts/deploy-configurator.sh
set -eu

: "${KODRA_AGENT_BUCKET:?set KODRA_AGENT_BUCKET to the site bucket}"
: "${KODRA_AGENT_DISTRIBUTION:?set KODRA_AGENT_DISTRIBUTION to the CloudFront distribution id}"
DIST=apps/configurator/dist
TARGET="s3://$KODRA_AGENT_BUCKET/agent"

pnpm build
test -f "$DIST/index.html"

# Content-hashed files first, cached for a year, so the new index.html never points at a
# missing file. Old hashed files stay: a browser holding the previous index.html still works.
aws s3 sync "$DIST/assets/" "$TARGET/assets/" --cache-control "public, max-age=31536000, immutable"

# The entry point is never cached.
aws s3 cp "$DIST/index.html" "$TARGET/index.html" \
  --cache-control "public, no-cache" --content-type "text/html; charset=utf-8"

# Only the configurator's paths: /agent and everything under it.
id=$(aws cloudfront create-invalidation --distribution-id "$KODRA_AGENT_DISTRIBUTION" \
  --paths "/agent*" --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$KODRA_AGENT_DISTRIBUTION" --id "$id"
echo "Published to $TARGET/ (invalidation $id complete)."
