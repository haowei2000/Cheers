import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const ts = require("typescript");

const paths = process.argv.slice(2);

if (paths.length === 0) {
  throw new Error("Pass one or more TSX files to migrate.");
}

const imports = {
  UiButton: 'import { Button as UiButton } from "@/components/ui/button";',
  UiInput: 'import { Input as UiInput } from "@/components/ui/input";',
  UiSelect: 'import { Select as UiSelect } from "@/components/ui/select";',
  UiTextarea: 'import { Textarea as UiTextarea } from "@/components/ui/textarea";',
};

function normalizedControlSource(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const controlTags = new Set(["UiButton", "UiInput", "UiSelect", "UiTextarea"]);

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (controlTags.has(tag)) {
        const classAttr = node.attributes.properties.find(
          (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className"
        );
        if (classAttr?.initializer) {
          const original = classAttr.initializer.getText(sourceFile);
          const fixedHeight = original.match(/\b(?:min-h|h)-(?:5|6|7|8|9|10|11|12|14|16)\b/)?.[0];
          const verticalPadding = /\bpy-[0-9.]+\b/.test(original);
          if (fixedHeight || verticalPadding) {
            const number = fixedHeight ? Number(fixedHeight.split("-").at(-1)) : 9;
            const size = number <= 7 ? "compact" : number >= 11 ? "comfortable" : "regular";
            const squareWidth = fixedHeight?.startsWith("h-") ? `w-${number}` : null;
            const square = squareWidth ? new RegExp(`\\b${squareWidth}\\b`).test(original) : false;
            let next = original
              .replace(/\b(?:min-h|h)-(?:5|6|7|8|9|10|11|12|14|16)\b/g, "")
              .replace(/\bpy-[0-9.]+\b/g, "")
              .replace(/\bmax-md:(?:h|min-h)-(?:5|6|7|8|9|10|11|12|14|16)\b/g, "");
            if (square) {
              next = next
                .replace(new RegExp(`\\b${squareWidth}\\b`, "g"), "")
                .replace(/\bmax-md:w-(?:5|6|7|8|9|10|11|12|14|16)\b/g, "");
            }
            next = next.replace(/[ \t]{2,}/g, " ");
            edits.push({
              start: classAttr.initializer.getStart(sourceFile),
              end: classAttr.initializer.getEnd(),
              text: next,
            });
            if (!node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "controlSize")) {
              edits.push({ start: classAttr.getStart(sourceFile), end: classAttr.getStart(sourceFile), text: `controlSize="${size}" ` });
            }
            if (square && tag === "UiButton" && !node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "square")) {
              edits.push({ start: classAttr.getStart(sourceFile), end: classAttr.getStart(sourceFile), text: "square " });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

for (const path of paths) {
  let source = fs.readFileSync(path, "utf8");
  const required = new Set();

  if (/<button\b/.test(source)) {
    source = source.replace(/<button\b/g, '<UiButton variant="plain"');
    source = source.replace(/<\/button>/g, "</UiButton>");
    required.add("UiButton");
  }

  source = source.replace(/<input\b[\s\S]*?\/>/g, (node) => {
    if (/\btype\s*=\s*["'](?:checkbox|file)["']/.test(node)) {
      const reason = /\btype\s*=\s*["']file["']/.test(node) ? "file-input" : "checkbox";
      return `{/* design-system-native: ${reason} */}\n${node}`;
    }
    required.add("UiInput");
    return node.replace(/^<input\b/, "<UiInput");
  });

  if (/<select\b/.test(source)) {
    source = source.replace(/<select\b/g, "<UiSelect");
    source = source.replace(/<\/select>/g, "</UiSelect>");
    required.add("UiSelect");
  }

  if (/<textarea\b/.test(source) && !/(MessageComposer|CodeEditor)\.tsx$/.test(path)) {
    source = source.replace(/<textarea\b/g, "<UiTextarea");
    source = source.replace(/<\/textarea>/g, "</UiTextarea>");
    required.add("UiTextarea");
  }

  const missingImports = [...required]
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(source.split("\n").filter((line) => line.startsWith("import ")).join("\n")))
    .map((name) => imports[name]);

  if (missingImports.length > 0) {
    source = `${missingImports.join("\n")}\n${source}`;
  }

  fs.writeFileSync(path, normalizedControlSource(source, path));
}
