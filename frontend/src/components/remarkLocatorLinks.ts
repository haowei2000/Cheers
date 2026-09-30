import { parseLocator } from "@/features/chat/locator";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const LOCATOR_TOKEN = /cheers:[^\s<>`"'()[\]]+/g;

/** Link bare Cheers locators in prose without changing code or existing links. */
export function remarkLocatorLinks() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference" || node.type === "code") return;
      const next: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value?.includes("cheers:")) {
          walk(child);
          next.push(child);
          continue;
        }
        const source = child.value;
        let cursor = 0;
        for (const match of source.matchAll(LOCATOR_TOKEN)) {
          const start = match.index;
          const token = match[0].replace(/[.,;!?]+$/, "");
          if (!token || !parseLocator(token)) continue;
          if (start > cursor) next.push({ type: "text", value: source.slice(cursor, start) });
          next.push({ type: "link", url: token, children: [{ type: "text", value: token }] });
          cursor = start + token.length;
        }
        if (cursor < source.length) next.push({ type: "text", value: source.slice(cursor) });
      }
      node.children = next;
    };
    walk(tree);
  };
}
