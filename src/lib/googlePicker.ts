type PickerDocument = {
  id?: string;
};

type PickerResponse = {
  action?: string;
  docs?: PickerDocument[];
};

type PickerView = {
  setIncludeFolders: (includeFolders: boolean) => PickerView;
  setMode: (mode: string) => PickerView;
  setSelectFolderEnabled: (enabled: boolean) => PickerView;
};

type PickerBuilder = {
  addView: (view: PickerView) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setCallback: (callback: (response: PickerResponse) => void) => PickerBuilder;
  setDeveloperKey: (apiKey: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

type GooglePicker = {
  Action: { PICKED: string; CANCEL: string };
  DocsViewMode: { LIST: string };
  Feature: { MULTISELECT_ENABLED: string };
  ViewId: { DOCS: string };
  DocsView: new (viewId: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
};

declare global {
  interface Window {
    gapi?: {
      load: (name: string, callback: () => void) => void;
    };
    google?: {
      picker?: GooglePicker;
    };
  }
}

let pickerApiPromise: Promise<GooglePicker> | null = null;

const loadPickerApi = () => {
  if (pickerApiPromise) return pickerApiPromise;

  pickerApiPromise = new Promise<GooglePicker>((resolve, reject) => {
    const loadModule = () => {
      if (!window.gapi) {
        reject(new Error('Google API loader is unavailable.'));
        return;
      }
      window.gapi.load('picker', () => {
        const picker = window.google?.picker;
        if (picker) resolve(picker);
        else reject(new Error('Google Picker API is unavailable.'));
      });
    };

    if (window.gapi) {
      loadModule();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>('script[data-google-picker-api]');
    if (existingScript) {
      existingScript.addEventListener('load', loadModule, { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Google Picker script failed to load.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.dataset.googlePickerApi = 'true';
    script.addEventListener('load', loadModule, { once: true });
    script.addEventListener('error', () => reject(new Error('Google Picker script failed to load.')), { once: true });
    document.head.appendChild(script);
  });

  return pickerApiPromise.catch((error) => {
    pickerApiPromise = null;
    throw error;
  });
};

export const getGooglePickerAppId = (clientId: string) => (
  clientId.match(/^(\d+)-/)?.[1] ?? ''
);

export const pickGoogleDriveFiles = async (
  token: string,
  {
    apiKey,
    appId,
  }: {
    apiKey: string;
    appId: string;
  },
) => {
  if (!apiKey) throw new Error('Google Picker API 키가 설정되지 않았습니다.');
  if (!appId) throw new Error('Google Picker 프로젝트 번호를 확인할 수 없습니다.');
  const picker = await loadPickerApi();

  return new Promise<string[]>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setMode(picker.DocsViewMode.LIST)
      .setSelectFolderEnabled(false);

    const instance = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setAppId(appId)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .setOrigin(window.location.origin)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) {
          resolve((response.docs ?? []).flatMap(({ id }) => id ? [id] : []));
        } else if (response.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();

    instance.setVisible(true);
  });
};
