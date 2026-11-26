type DocsView = { setFileIds(ids: string): DocsView; setMode(mode: string): DocsView };
type Picker = { setVisible(visible: boolean): void; dispose(): void };
type PickerResult = { action: string; docs?: { id?: string }[] };
type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (result: PickerResult) => void): PickerBuilder;
  build(): Picker;
};
type PickerApi = {
  DocsView: new (id: string) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: string };
  DocsViewMode: { LIST: string };
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string; ERROR: string };
};
type GoogleWindow = Window & {
  google?: { picker?: PickerApi };
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void };
};

let loading: Promise<PickerApi> | undefined;
function loadPicker() {
  const browser = window as GoogleWindow;
  if (browser.google?.picker) return Promise.resolve(browser.google.picker);
  loading ??= new Promise<PickerApi>((resolve, reject) => {
    const fail = () => reject(new Error('Google Picker unavailable'));
    const load = () => {
      if (!browser.gapi) return fail();
      browser.gapi.load('picker', {
        callback: () => browser.google?.picker ? resolve(browser.google.picker) : fail(),
        onerror: fail, timeout: 10_000, ontimeout: fail,
      });
    };
    if (browser.gapi) {
      load();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    const timer = window.setTimeout(() => { script.remove(); fail(); }, 10_000);
    script.onload = () => { window.clearTimeout(timer); load(); };
    script.onerror = () => { window.clearTimeout(timer); script.remove(); fail(); };
    document.head.append(script);
  }).catch((error) => { loading = undefined; throw error; });
  return loading;
}

export async function pickSharedDriveFiles({ ids, token, pickerKey, appId, signal }: {
  ids: string[]; token: string; pickerKey: string; appId: string; signal: AbortSignal;
}): Promise<string[]> {
  const api = await loadPicker();
  signal.throwIfAborted();
  const candidates = new Set(ids);
  return new Promise((resolve, reject) => {
    let picker: Picker | undefined;
    const close = () => {
      signal.removeEventListener('abort', cancel);
      picker?.dispose();
      picker = undefined;
    };
    const cancel = () => { close(); resolve([]); };
    const view = new api.DocsView(api.ViewId.DOCS).setFileIds(ids.join(',')).setMode(api.DocsViewMode.LIST);
    picker = new api.PickerBuilder()
      .addView(view)
      .enableFeature(api.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(pickerKey)
      .setAppId(appId)
      .setOrigin(window.location.origin)
      .setTitle('서재로 가져올 도서 선택')
      .setCallback((result) => {
        if (result.action === api.Action.PICKED) {
          const selected = result.docs?.map(({ id }) => id).filter((id): id is string => Boolean(id && candidates.has(id))) ?? [];
          close();
          resolve([...new Set(selected)]);
        } else if (result.action === api.Action.CANCEL) {
          cancel();
        } else if (result.action === api.Action.ERROR) {
          close();
          reject(new Error('Google Picker unavailable'));
        }
      })
      .build();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      picker.setVisible(true);
    } catch (error) {
      close();
      reject(error);
    }
  });
}
