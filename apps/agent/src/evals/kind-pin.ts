/**
 * The kind release in the agent image, for `kodra-agent demo` (L3). Checksums are the
 * release's own .sha256sum files, checked when the image is built (scripts/install-kind.ts).
 */
export const KIND_VERSION = 'v0.33.0';
export const KIND_SHA256: Readonly<Record<string, string>> = {
  x64: 'aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d',
  arm64: '20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2',
};
const ARCH: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' };

export function kindUrl(arch: string): string | null {
  const name = ARCH[arch];
  return name
    ? `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${name}`
    : null;
}
