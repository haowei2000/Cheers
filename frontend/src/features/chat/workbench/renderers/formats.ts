// Coarse wire format for sandbox transport; not a view selector.
export function formatOf(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".md") || p.endsWith(".markdown")) return "markdown";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
  if (p.endsWith(".toml")) return "toml";
  if (p.endsWith(".xml")) return "xml";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "react";
  return "text";
}

