export interface RenderedFile {
  path: string;
  format: string;
  content: string;
  version: number;
  rendererId: string;
}

export interface RendererContext<ContextTarget = unknown> {
  file: {
    onRender(handler: (file: RenderedFile) => void | Promise<void>): void;
    save(content: string): Promise<{ version: number }>;
  };
  channel: {
    read<T = unknown>(resource: string, params?: Record<string, unknown>): Promise<T>;
  };
  navigation: { open(uri: string): Promise<void> };
  composer: { prefill(text: string): Promise<void> };
  context: {
    pick(event: Pick<MouseEvent, "clientX" | "clientY" | "preventDefault">, target: ContextTarget): void;
    onAdded(handler: (result: { label: string; startLine: number; endLine: number }) => void): void;
  };
  automation: {
    list<T = unknown>(): Promise<T[]>;
    create<T = unknown>(automationId: string, input: unknown): Promise<T>;
    update<T = unknown>(taskId: string, input: unknown): Promise<T>;
    delete(taskId: string): Promise<void>;
    run(taskId: string): Promise<string>;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface RendererDefinition<ContextTarget = unknown> {
  /** Convert a renderer-owned row/card/node into one exact source anchor. */
  toContext(target: ContextTarget): { label: string; sourceText: string } | Promise<{ label: string; sourceText: string }>;
  activate(context: RendererContext<ContextTarget>): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

declare global {
  // The host reads this inside an opaque-origin sandbox after the bundle loads.
  // eslint-disable-next-line no-var
  var CheersWorkbenchRenderer: RendererDefinition<unknown> | undefined;
}

export function defineRenderer<ContextTarget>(definition: RendererDefinition<ContextTarget>): RendererDefinition<ContextTarget> {
  globalThis.CheersWorkbenchRenderer = definition as RendererDefinition<unknown>;
  return definition;
}
