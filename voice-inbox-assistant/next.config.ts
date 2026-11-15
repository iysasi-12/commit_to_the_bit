import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone for the Docker image (see Dockerfile).
  output: "standalone",
  // This app lives inside a larger repo: trace files from this folder only, so the standalone
  // output is flat (.next/standalone/server.js) instead of nested under the repo's path.
  outputFileTracingRoot: process.cwd(),
  turbopack: {
    // Same reason: pin the root so Next doesn't use the parent folder's lockfile.
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
