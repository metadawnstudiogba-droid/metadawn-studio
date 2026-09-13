import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "proper-lockfile", "undici", "pg"],
  experimental: { serverActions: { bodySizeLimit: "64mb" } },
};

export default nextConfig;
