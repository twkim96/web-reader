const PICKED_FILE_IDS_KEY = 'google_drive_picked_file_ids';
const MAX_PICKED_FILE_IDS = 50;

const normalizeIds = (ids: unknown) => (
  Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
);

export const getPickedDriveFileIds = () => {
  if (typeof window === 'undefined') return [];

  try {
    return normalizeIds(JSON.parse(localStorage.getItem(PICKED_FILE_IDS_KEY) ?? '[]'))
      .slice(0, MAX_PICKED_FILE_IDS);
  } catch {
    return [];
  }
};

export const rememberPickedDriveFileIds = (ids: string[]) => {
  const nextIds = [...new Set([...ids, ...getPickedDriveFileIds()])].slice(0, MAX_PICKED_FILE_IDS);
  localStorage.setItem(PICKED_FILE_IDS_KEY, JSON.stringify(nextIds));
};

export const forgetPickedDriveFileId = (id: string) => {
  const nextIds = getPickedDriveFileIds().filter((storedId) => storedId !== id);
  localStorage.setItem(PICKED_FILE_IDS_KEY, JSON.stringify(nextIds));
};
