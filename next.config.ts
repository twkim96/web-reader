import type { NextConfig } from "next";
import { computeAppBuildId } from './scripts/app-build-id.mjs';

const appBuildId: string = computeAppBuildId(process.cwd(), process.env);

const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'web-novel-viewer';
const firebaseAuthHost = `${firebaseProjectId}.firebaseapp.com`;

const nextConfig: NextConfig = {
  generateBuildId: async () => appBuildId,
  env: { NEXT_PUBLIC_APP_BUILD_ID: appBuildId },
  async headers() {
    return [{ source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }];
  },
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
