import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // This app lives inside a larger repo; pin the root so Next doesn't use the parent folder.
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
