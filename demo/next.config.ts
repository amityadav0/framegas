import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(process.cwd(), "..");

const config: NextConfig = {
  // Next 16 writes an AGENTS.md into the app on dev start by default; this repo keeps none.
  agentRules: false,
  // The demo is recorded from dev mode: no floating dev badge.
  devIndicators: false,
  // The SDK is a workspace package shipped as TypeScript source.
  transpilePackages: ["@framegas/sdk"],
  // The SDK's source imports "./x.js" for "./x.ts", as NodeNext requires. Webpack can map that; Turbopack cannot yet.
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return webpackConfig;
  },
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: { "/**": ["../docs/evidence/**", "../deployments/devnet.json"] },
};

export default config;
