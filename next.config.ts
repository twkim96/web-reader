import type { NextConfig } from "next";
import { computeAppBuildId } from './scripts/app-build-id.mjs';

const finiteSyncLeases = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES
  ?? (process.env.VERCEL_ENV === 'production' ? '1' : '0');
const appBuildId: string = computeAppBuildId(process.cwd(), {
  ...process.env,
  NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES: finiteSyncLeases,
});

const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'web-novel-viewer';
const firebaseAuthHost = `${firebaseProjectId}.firebaseapp.com`;

const nextConfig: NextConfig = {
  generateBuildId: async () => appBuildId,
  env: {
    NEXT_PUBLIC_APP_BUILD_ID: appBuildId,
    NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES: finiteSyncLeases,
  },
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
