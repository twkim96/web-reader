import { getAdminAuth, getAdminFirestore } from '../../../../server/firebaseAdmin';
import { adminMaintenanceDependencies, createMaintenancePost, maintenanceAdmin } from '../../../../server/syncReceiptMaintenance';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const POST = createMaintenancePost({
  enabled: () => process.env.ENABLE_FINITE_SYNC_CLEANUP === '1',
  verifyToken: token => getAdminAuth().verifyIdToken(token, true),
  run: uid => {
    const db = getAdminFirestore();
    return maintenanceAdmin(uid, adminMaintenanceDependencies(db), { dryRun: false });
  },
});
