import path from "node:path";

const RAW_TAGS = ["button", "input", "select", "textarea"];
const SHARED_CONTROLS = new Set([
  "Button",
  "IconButton",
  "Input",
  "Select",
  "Textarea",
  "ItemRow",
  "EntityItem",
  "NavigationItem",
  "OperationsItem",
  "WorkbenchItem",
  "MenuOption",
  "TabOption",
  "CheckboxField",
  "UiButton",
  "UiInput",
  "UiSelect",
  "UiTextarea",
]);
const NON_STANDARD_RADIUS = new Set([
  "rounded",
  "rounded-md",
  "rounded-lg",
  "rounded-xl",
  "rounded-2xl",
]);

export function emptyNativeCounts() {
  return Object.fromEntries(RAW_TAGS.map((tag) => [tag, 0]));
}

function commentReason(source, start, kind) {
  const before = source.slice(Math.max(0, start - 320), start);
  const pattern = new RegExp(`design-system-${kind}:\\s*([a-z0-9-]+)`, "g");
  return Array.from(before.matchAll(pattern)).at(-1)?.[1];
}

function classText(node, sourceFile, ts) {
  const attr = node.attributes?.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className"
  );
  if (!attr?.initializer) return "";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return attr.initializer.expression.getText(sourceFile);
  }
  return "";
}

function attributeReason(node, sourceFile, ts, kind) {
  const attr = node.attributes?.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === `data-design-system-${kind}`
  );
  return attr?.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined;
}

function classTokens(value) {
  return value
    .replace(/["'`{}(),?:]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^!/, ""));
}

function isDevelopmentFile(file) {
  return /\.(?:test|preview)\.tsx$/.test(file) || /ItemGallery(?:\.preview)?\.tsx$/.test(file);
}

function isPrimitiveFile(file) {
  return file.includes(`${path.sep}components${path.sep}ui${path.sep}`);
}

export function auditSources(files, ts, policy) {
  const result = {
    native: {
      production: emptyNativeCounts(),
      business: emptyNativeCounts(),
      primitive: emptyNativeCounts(),
      development: emptyNativeCounts(),
    },
    unexemptedBusinessNative: emptyNativeCounts(),
    violations: {
      nonStandardRadius: 0,
      unregisteredFullRadius: 0,
      restingBorder: 0,
      hardcodedControlSize: 0,
      sharedControlSizeOverride: 0,
    },
    findings: [],
    invalidReasons: [],
  };

  const allowedNative = new Set(policy.allowedNativeReasons ?? []);
  const allowedExempt = new Set(policy.allowedExemptReasons ?? []);

  for (const { file, source } of files) {
    const development = isDevelopmentFile(file);
    const primitive = !development && isPrimitiveFile(file);
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    for (const match of source.matchAll(/design-system-(native|exempt):\s*([a-z0-9-]+)/g)) {
      const [, kind, reason] = match;
      const allowed = kind === "native" ? allowedNative : allowedExempt;
      if (!allowed.has(reason)) result.invalidReasons.push({ file, reason, kind });
    }

    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sourceFile);
        const start = node.getStart(sourceFile);
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const nativeReason = attributeReason(node, sourceFile, ts, "native") ?? commentReason(source, start, "native");
        const exemptReason = attributeReason(node, sourceFile, ts, "exempt") ?? commentReason(source, start, "exempt");
        if (nativeReason && !allowedNative.has(nativeReason)) result.invalidReasons.push({ file, reason: nativeReason, kind: "native" });
        if (exemptReason && !allowedExempt.has(exemptReason)) result.invalidReasons.push({ file, reason: exemptReason, kind: "exempt" });
        const exempt =
          (nativeReason && allowedNative.has(nativeReason)) ||
          (exemptReason && allowedExempt.has(exemptReason));

        if (RAW_TAGS.includes(tag)) {
          const bucket = development ? "development" : primitive ? "primitive" : "business";
          result.native[bucket][tag] += 1;
          if (!development) result.native.production[tag] += 1;
          if (bucket === "business" && !exempt) result.unexemptedBusinessNative[tag] += 1;
        }

        if (!development) {
          const tokens = classTokens(classText(node, sourceFile, ts));
          for (const token of tokens) {
            if (NON_STANDARD_RADIUS.has(token) && !exempt) {
              result.violations.nonStandardRadius += 1;
              result.findings.push({ file, line, rule: "nonStandardRadius", token });
            }
            if (token === "rounded-full" && !exempt) {
              result.violations.unregisteredFullRadius += 1;
              result.findings.push({ file, line, rule: "unregisteredFullRadius", token });
            }
            if (token === "border" && !exempt) {
              result.violations.restingBorder += 1;
              result.findings.push({ file, line, rule: "restingBorder", token });
            }
          }

          const dimensionTokens = tokens.filter((token) => /^(?:h|min-h)-(?:6|8|10|12|14|16|\[[^\]]+\])$/.test(token));
          if (RAW_TAGS.includes(tag) && dimensionTokens.length && !exempt) {
            result.violations.hardcodedControlSize += dimensionTokens.length;
            result.findings.push({ file, line, rule: "hardcodedControlSize", token: dimensionTokens.join(" ") });
          }
          const overrideTokens = tokens.filter((token) => /^(?:h|min-h|py)-(?:[0-9.]+|\[[^\]]+\])$/.test(token));
          if (SHARED_CONTROLS.has(tag) && overrideTokens.length && !exempt) {
            result.violations.sharedControlSizeOverride += overrideTokens.length;
            result.findings.push({ file, line, rule: "sharedControlSizeOverride", token: overrideTokens.join(" ") });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return result;
}

export function enforceAudit(result, policy) {
  const errors = [];
  for (const scope of ["production", "business"]) {
    for (const tag of RAW_TAGS) {
      const ceiling = policy.nativeElementCeilings?.[scope]?.[tag];
      const count = result.native[scope][tag];
      if (typeof ceiling !== "number") errors.push(`missing ${scope}.${tag} ceiling`);
      else if (count > ceiling) errors.push(`${scope} native ${tag} increased from ${ceiling} to ${count}`);
    }
  }
  for (const tag of RAW_TAGS) {
    const ceiling = policy.unexemptedBusinessNativeCeilings?.[tag];
    const count = result.unexemptedBusinessNative[tag];
    if (typeof ceiling !== "number") errors.push(`missing unexempted business ${tag} ceiling`);
    else if (count > ceiling) errors.push(`unexempted business native ${tag} increased from ${ceiling} to ${count}`);
  }
  for (const [rule, count] of Object.entries(result.violations)) {
    const ceiling = policy.violationCeilings?.[rule];
    if (typeof ceiling !== "number") errors.push(`missing ${rule} ceiling`);
    else if (count > ceiling) errors.push(`${rule} increased from ${ceiling} to ${count}`);
  }
  for (const invalid of result.invalidReasons) {
    errors.push(`${invalid.file}: unknown design-system-${invalid.kind} reason ${invalid.reason}`);
  }
  return errors;
}
