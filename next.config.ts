import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/__/auth/:path*',
        destination: 'https://web-novel-viewer.firebaseapp.com/__/auth/:path*',
      },
    ];
  },
};

export default nextConfig;
