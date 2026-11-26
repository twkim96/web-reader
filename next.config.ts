import type { NextConfig } from "next";
import { computeAppBuildId } from './scripts/app-build-id.mjs';

const isPreview = process.env.VERCEL_ENV === 'preview';
const approvedPreviewAuthHosts = new Set([
  'twreader-git-preview-mypage-twkims-projects-b9c7f5a3.vercel.app',
  'twreader-git-codex-shared-drive-button-twkims-projects-b9c7f5a3.vercel.app',
]);
const branchHost = process.env.VERCEL_BRANCH_URL ?? '';
const previewAuthHost = isPreview && approvedPreviewAuthHosts.has(branchHost)
  ? branchHost
  : '';
const finiteSyncLeases = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES
  ?? (process.env.VERCEL_ENV === 'production' ? '1' : '0');
const appBuildId: string = computeAppBuildId(process.cwd(), {
  ...process.env,
  NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES: finiteSyncLeases,
  NEXT_PUBLIC_WEB_READER_PREVIEW_AUTH_HOST: previewAuthHost,
});

const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'web-novel-viewer';
const firebaseAuthHost = `${firebaseProjectId}.firebaseapp.com`;
const tailnetDevHost = process.env.WEB_READER_TAILSCALE_DEV_HOST?.trim().toLowerCase();
const allowedDevOrigins = tailnetDevHost && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(tailnetDevHost)
  ? [tailnetDevHost]
  : undefined;

const nextConfig: NextConfig = {
  allowedDevOrigins,
  outputFileTracingIncludes: {
    '/api/mypage': ['./public/catalog/discovery.v1.json'],
    '/api/book-reviews': ['./public/catalog/discovery.v1.json'],
  },
  generateBuildId: async () => appBuildId,
  env: {
    NEXT_PUBLIC_APP_BUILD_ID: appBuildId,
    NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES: finiteSyncLeases,
    NEXT_PUBLIC_WEB_READER_PREVIEW: isPreview ? '1' : '0',
    NEXT_PUBLIC_WEB_READER_PREVIEW_AUTH_HOST: previewAuthHost,
    NEXT_PUBLIC_WEB_READER_TAILSCALE_DEV_HOST: allowedDevOrigins?.[0] ?? '',
  },
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/catalog/synopses/:file([0-9a-f]{64}\\.json)', headers: [
        { key: 'Cache-Control', value: 'public, max-age=86400, immutable' },
      ] },
    ];
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
