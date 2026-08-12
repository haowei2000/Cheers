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
const SHARED_CONTENT = new Set(["Avatar", "EditorialIcon", "PresenceDot"]);
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

function staticExpressionText(expression, sourceFile, ts, declarations, seen = new Set()) {
  if (!expression) return "";
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return "";
    const initializer = declarations.get(expression.text);
    if (!initializer) return "";
    const next = new Set(seen);
    next.add(expression.text);
    return staticExpressionText(initializer, sourceFile, ts, declarations, next);
  }
  if (ts.isTemplateExpression(expression)) {
    return [
      expression.head.text,
      ...expression.templateSpans.flatMap((span) => [
        staticExpressionText(span.expression, sourceFile, ts, declarations, seen),
        span.literal.text,
      ]),
    ].join(" ");
  }
  if (ts.isConditionalExpression(expression)) {
    return `${staticExpressionText(expression.whenTrue, sourceFile, ts, declarations, seen)} ${staticExpressionText(expression.whenFalse, sourceFile, ts, declarations, seen)}`;
  }
  if (ts.isBinaryExpression(expression)) {
    return `${staticExpressionText(expression.left, sourceFile, ts, declarations, seen)} ${staticExpressionText(expression.right, sourceFile, ts, declarations, seen)}`;
  }
  if (ts.isCallExpression(expression) || ts.isArrayLiteralExpression(expression)) {
    const values = ts.isCallExpression(expression) ? expression.arguments : expression.elements;
    return values.map((value) => staticExpressionText(value, sourceFile, ts, declarations, seen)).join(" ");
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticExpressionText(expression.expression, sourceFile, ts, declarations, seen);
  }
  return "";
}

function classText(node, sourceFile, ts, declarations) {
  const attr = node.attributes?.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className"
  );
  if (!attr?.initializer) return "";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return staticExpressionText(attr.initializer.expression, sourceFile, ts, declarations);
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

function utilityBase(token) {
  return token.split(":").at(-1);
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
      sharedHorizontalPaddingOverride: 0,
      sharedControlWidthOverride: 0,
      sharedContentSizeOverride: 0,
      sharedPaddingOverride: 0,
      nonStandardRowHeight: 0,
      nonStandardIdentitySize: 0,
      nonStandardIconSize: 0,
      nonStandardSpacing: 0,
      arbitrarySpinnerSize: 0,
      nonStandardTypographySize: 0,
      legacyControlSizeProp: 0,
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
    const declarations = new Map();
    const collectDeclarations = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        declarations.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(sourceFile);

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
          const tokens = classTokens(classText(node, sourceFile, ts, declarations));
          const spacingTokens = tokens.filter((token) => /^(?:-)?(?:p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy])-(?:0\.5|1\.5|2\.5|3\.5)$/.test(utilityBase(token)));
          if (spacingTokens.length) {
            result.violations.nonStandardSpacing += spacingTokens.length;
            result.findings.push({ file, line, rule: "nonStandardSpacing", token: spacingTokens.join(" ") });
          }
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
          const horizontalPaddingTokens = tokens.filter((token) => /^(?:px|pl|pr)-(?:[0-9.]+|\[[^\]]+\])$/.test(utilityBase(token)));
          if (!primitive && SHARED_CONTROLS.has(tag) && horizontalPaddingTokens.length && !exempt) {
            result.violations.sharedHorizontalPaddingOverride += horizontalPaddingTokens.length;
            result.findings.push({ file, line, rule: "sharedHorizontalPaddingOverride", token: horizontalPaddingTokens.join(" ") });
          }
          const paddingTokens = tokens.filter((token) => /^p-(?:[0-9.]+|\[[^\]]+\])$/.test(utilityBase(token)));
          if (!primitive && SHARED_CONTROLS.has(tag) && paddingTokens.length) {
            result.violations.sharedPaddingOverride += paddingTokens.length;
            result.findings.push({ file, line, rule: "sharedPaddingOverride", token: paddingTokens.join(" ") });
          }
          const widthTokens = tokens.filter((token) => /^w-(?:[0-9.]+|full|fit|min|max|\[[^\]]+\])$/.test(utilityBase(token)));
          if (!primitive && SHARED_CONTROLS.has(tag) && widthTokens.length && !exempt) {
            result.violations.sharedControlWidthOverride += widthTokens.length;
            result.findings.push({ file, line, rule: "sharedControlWidthOverride", token: widthTokens.join(" ") });
          }
          const contentDimensionTokens = tokens.filter((token) => /^(?:h|w)-(?:[0-9.]+|\[[^\]]+\])$/.test(utilityBase(token)));
          if (!primitive && SHARED_CONTENT.has(tag) && contentDimensionTokens.length && !exempt) {
            result.violations.sharedContentSizeOverride += contentDimensionTokens.length;
            result.findings.push({ file, line, rule: "sharedContentSizeOverride", token: contentDimensionTokens.join(" ") });
          }

          const rowHeightTokens = tokens.filter((token) => /^(?:h|min-h)-(?:8|10|12|14)$/.test(utilityBase(token)));
          if (["div", "header"].includes(tag) && tokens.includes("flex") && tokens.includes("items-center") && rowHeightTokens.length) {
            result.violations.nonStandardRowHeight += rowHeightTokens.length;
            result.findings.push({ file, line, rule: "nonStandardRowHeight", token: rowHeightTokens.join(" ") });
          }

          const dimensions = Object.fromEntries(tokens.map((token) => {
            const match = utilityBase(token).match(/^(h|w)-([0-9.]+|\[[0-9.]+px\])$/);
            return match ? [match[1], match[2]] : [];
          }).filter((entry) => entry.length));
          if (exemptReason === "identity" && dimensions.h && dimensions.h === dimensions.w && !["5", "7", "9"].includes(dimensions.h)) {
            result.violations.nonStandardIdentitySize += 1;
            result.findings.push({ file, line, rule: "nonStandardIdentitySize", token: `h-${dimensions.h} w-${dimensions.w}` });
          }
          const isComponent = /^[A-Z]/.test(tag);
          if (isComponent && !SHARED_CONTROLS.has(tag) && !SHARED_CONTENT.has(tag) && dimensions.h && dimensions.h === dimensions.w && !["3.5", "4", "5"].includes(dimensions.h)) {
            result.violations.nonStandardIconSize += 1;
            result.findings.push({ file, line, rule: "nonStandardIconSize", token: `h-${dimensions.h} w-${dimensions.w}` });
          }

          const forbiddenTypographyTokens = tokens.filter((token) =>
            /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]*(?:px|rem|em|clamp|calc)[^\]]*\])$/.test(utilityBase(token))
          );
          if (forbiddenTypographyTokens.length) {
            result.violations.nonStandardTypographySize += forbiddenTypographyTokens.length;
            result.findings.push({ file, line, rule: "nonStandardTypographySize", token: forbiddenTypographyTokens.join(" ") });
          }

          if (SHARED_CONTROLS.has(tag)) {
            const legacySize = node.attributes?.properties.find(
              (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "size"
            );
            if (legacySize) {
              result.violations.legacyControlSizeProp += 1;
              result.findings.push({ file, line, rule: "legacyControlSizeProp", token: "size" });
            }
          }
          if (tag === "Spinner") {
            const arbitrarySize = node.attributes?.properties.find(
              (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "size"
            );
            if (arbitrarySize) {
              result.violations.arbitrarySpinnerSize += 1;
              result.findings.push({ file, line, rule: "arbitrarySpinnerSize", token: "size" });
            }
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
