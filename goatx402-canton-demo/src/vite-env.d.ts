/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FACILITATOR_URL?: string;
  readonly VITE_MERCHANT_URL?: string;
  readonly VITE_RESOURCE_PATH?: string;
  readonly VITE_PAYER_PARTY?: string;
  readonly VITE_PAYER_TOKEN?: string;
  readonly VITE_SOURCE_HOLDING_CID?: string;
  readonly VITE_WAIT_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
