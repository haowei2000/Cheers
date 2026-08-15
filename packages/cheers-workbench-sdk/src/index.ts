export interface RenderedFile {
  path: string;
  format: string;
  content: string;
  version: number;
  rendererId: string;
}

export interface RendererContext {
  file: {
    onRender(handler: (file: RenderedFile) => void | Promise<void>): void;
    save(content: string): Promise<{ version: number }>;
  };
  channel: {
    read<T = unknown>(resource: string, params?: Record<string, unknown>): Promise<T>;
  };
  navigation: { open(uri: string): Promise<void> };
  composer: { prefill(text: string): Promise<void> };
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface RendererDefinition {
  activate(context: RendererContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

declare global {
  // The host reads this inside an opaque-origin sandbox after the bundle loads.
  // eslint-disable-next-line no-var
  var CheersWorkbenchRenderer: RendererDefinition | undefined;
}

export function defineRenderer(definition: RendererDefinition): RendererDefinition {
  globalThis.CheersWorkbenchRenderer = definition;
  return definition;
}
