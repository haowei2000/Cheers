import { compileArtifactTsx } from "./artifactCompiler";

self.onmessage = (event: MessageEvent<{ source: string }>) => {
  try {
    self.postMessage({ code: compileArtifactTsx(event.data.source) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
