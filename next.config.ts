import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const apiTarget = (
      process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000"
    ).replace(/\/+$/, "");
    return [
      {
        source: "/events",
        destination: "/?view=events",
      },
      {
        source: "/api/v1/:path*",
        destination: `${apiTarget}/api/v1/:path*`,
      },
      {
        source: "/admin/:path*/",
        destination: `${apiTarget}/admin/:path*/`,
      },
      {
        source: "/admin/:path*",
        destination: `${apiTarget}/admin/:path*`,
      },
      {
        source: "/static/:path*",
        destination: `${apiTarget}/static/:path*`,
      },
    ];
  },
};

export default nextConfig;
