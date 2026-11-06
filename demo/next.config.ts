import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(process.cwd(), "..");

const config: NextConfig = {
  // Next 16 writes an AGENTS.md into the app on dev start by default; this repo keeps none.
  agentRules: false,
  // The demo is recorded from dev mode: no floating dev badge.
  devIndicators: false,
  // The SDK is a workspace package; the demo's build script builds its dist/ first.
  transpilePackages: ["@framegas/sdk"],
  // NodeNext-style "./x.js" imports of "./x.ts": webpack can map them, Turbopack cannot yet.
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return webpackConfig;
  },
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: { "/**": ["../docs/evidence/*.json", "../deployments/devnet.json"] },
};

export default config;
