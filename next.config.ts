import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { join } from "node:path";

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) process.env.STUDIO_DATA_DIR ||= join(process.cwd(), ".studio-data");
  return {
    serverExternalPackages: ["@electric-sql/pglite", "proper-lockfile", "undici", "pg"],
    experimental: { serverActions: { bodySizeLimit: "64mb" } },
  };
}
