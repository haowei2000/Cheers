/**
 * 本地 ambient declaration for openclaw/plugin-sdk/channel-entry-contract.
 *
 * 这是为了在不把 openclaw 作为 devDependency 安装的情况下，让 tsc 能通过编译。
 * 运行时由 OpenClaw CLI 自己的 node_modules 提供真实实现。
 *
 * 形状对齐 /opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/plugin-sdk/
 * channel-entry-contract.d.ts（OpenClaw 2026.4.15）。
 */
declare module "openclaw/plugin-sdk/channel-entry-contract" {
  export interface BundledEntryModuleRef {
    specifier: string;
    exportName?: string;
  }

  export interface BundledChannelEntryOptions {
    id: string;
    name: string;
    description: string;
    importMetaUrl: string;
    plugin: BundledEntryModuleRef;
    secrets?: BundledEntryModuleRef;
    configSchema?: unknown | (() => unknown);
    runtime?: BundledEntryModuleRef;
    accountInspect?: BundledEntryModuleRef;
    features?: { accountInspect?: boolean };
    registerCliMetadata?: (api: unknown) => void;
    registerFull?: (api: unknown) => void;
  }

  export interface BundledChannelSetupEntryOptions {
    importMetaUrl: string;
    plugin: BundledEntryModuleRef;
    secrets?: BundledEntryModuleRef;
    runtime?: BundledEntryModuleRef;
    features?: {
      legacyStateMigrations?: boolean;
      legacySessionSurfaces?: boolean;
    };
  }

  export function defineBundledChannelEntry(opts: BundledChannelEntryOptions): unknown;
  export function defineBundledChannelSetupEntry(opts: BundledChannelSetupEntryOptions): unknown;
  export function loadBundledEntryExportSync<T>(importMetaUrl: string, ref: BundledEntryModuleRef): T;
}
