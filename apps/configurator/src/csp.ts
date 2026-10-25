/**
 * The page may load only its own files and may not make any network request
 * (`connect-src 'none'`). The build puts this in a meta tag; CloudFront sends it as a header
 * too, with frame-ancestors, which a meta tag cannot set (terraform:
 * Modules/cloudfront/functions/agent-configurator-headers.js). `pnpm check:deploy` checks that
 * the live header is exactly HEADER_CONTENT_SECURITY_POLICY.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export const HEADER_CONTENT_SECURITY_POLICY = `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`;
