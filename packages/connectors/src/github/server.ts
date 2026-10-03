import type { ServerSource } from '@kodra-agent/schema';

/**
 * github/github-mcp-server v1.13.0, shared by the GitHub and GitHub Actions connectors.
 * Hashes match the project's published checksums. See docs/connectors/github.md.
 */
export const GITHUB_SERVER: ServerSource = {
  kind: 'github-release',
  repo: 'github/github-mcp-server',
  version: 'v1.13.0',
  assets: {
    'linux-x64': {
      file: 'github-mcp-server_Linux_x86_64.tar.gz',
      sha256: '9cea00809d11c0ff5d0ad9497d6f7a0af690a3d2873068b88bf8bb2985bf5112',
      archive: 'tar.gz',
      binary: 'github-mcp-server',
    },
    'linux-arm64': {
      file: 'github-mcp-server_Linux_arm64.tar.gz',
      sha256: '0fa71b182cfc9c192369f7d97d6ae81c3a8c1b725f19cc6d3358ba477eec2e14',
      archive: 'tar.gz',
      binary: 'github-mcp-server',
    },
    'darwin-arm64': {
      file: 'github-mcp-server_Darwin_arm64.tar.gz',
      sha256: 'e1fe3c89d5de8672955f94df12928b0023ce4ea20e0a78e6c3017b36fede04b2',
      archive: 'tar.gz',
      binary: 'github-mcp-server',
    },
    'win32-x64': {
      file: 'github-mcp-server_Windows_x86_64.zip',
      sha256: '75accfd7f98c2d06c8cbda43d7d243a51a97baced7e6a5d61dd6f7df710fd464',
      archive: 'zip',
      binary: 'github-mcp-server.exe',
    },
  },
};

/** Lockdown mode filters content from users without push access (less prompt injection). */
export const GITHUB_COMMON_ARGS = ['stdio', '--lockdown-mode'];
