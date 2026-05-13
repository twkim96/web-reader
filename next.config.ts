import type { NextConfig } from "next";

const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'web-novel-viewer';
const firebaseAuthHost = `${firebaseProjectId}.firebaseapp.com`;

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/__/auth/:path*',
        destination: `https://${firebaseAuthHost}/__/auth/:path*`,
      },
      {
        source: '/__/firebase/:path*',
        destination: `https://${firebaseAuthHost}/__/firebase/:path*`,
      },
    ];
  },
};

export default nextConfig;
