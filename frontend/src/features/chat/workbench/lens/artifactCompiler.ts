import * as Babel from "@babel/standalone";
import { MAX_ARTIFACT_SOURCE_LENGTH } from "./artifactLimits";

/** Compile code as data. The returned JavaScript is executed only inside the iframe. */
export function compileArtifactTsx(source: string): string {
  if (source.length > MAX_ARTIFACT_SOURCE_LENGTH) throw new Error("Preview source is too large");
  // Keep line breaks so Babel's loc data still points into the original file.
  const sanitized = source
    .replace(/^[ \t]*import[^\n]*from[ \t]*['"][^'"]*['"];?[ \t]*$/gm, "")
    .replace(/^[ \t]*export[ \t]+default[ \t]+/gm, "window.__CHEERS_ROOT_COMPONENT__ = ")
    .replace(/^[ \t]*export[ \t]+(const|function|let|var|class)[ \t]+/gm, "$1 ");

  const sourceLocationPlugin = ({ types }: { types: typeof Babel.packages.types }) => ({
    visitor: {
      JSXOpeningElement(path: { node: import("@babel/types").JSXOpeningElement }) {
        const name = path.node.name;
        if (!types.isJSXIdentifier(name) || !/^[a-z]/.test(name.name)) return;
        if (path.node.attributes.some((attribute) => types.isJSXAttribute(attribute)
          && types.isJSXIdentifier(attribute.name) && attribute.name.name === "data-cheers-source")) return;
        const line = path.node.loc?.start.line;
        if (!line) return;
        path.node.attributes.push(types.jsxAttribute(
          types.jsxIdentifier("data-cheers-source"),
          types.stringLiteral(String(line)),
        ));
      },
    },
  });

  return Babel.transform(sanitized, {
    filename: "artifact.tsx",
    sourceType: "script",
    presets: ["react", "typescript"],
    plugins: [sourceLocationPlugin],
  }).code ?? "";
}
