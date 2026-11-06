import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(process.cwd(), "..");

const config: NextConfig = {
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
