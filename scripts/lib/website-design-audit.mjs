/** @file
 * Static CSS audit for the standalone website's typography, radii, borders,
 * and control geometry. The returned findings include source line locations.
 */

const TYPOGRAPHY_SIZES = new Set(["10", "12", "14", "16"]);
const CONTROL_SIZES = new Set(["28", "36", "44"]);

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function selectorBefore(source, index) {
  const open = source.lastIndexOf("{", index);
  if (open < 0) return "";
  const close = source.lastIndexOf("}", open);
  return source.slice(close + 1, open).trim();
}

function isSemanticCircle(selector) {
  return /(?:^|[\s,])\.(?:avatar|presence|unread|progress|dot)(?:[\s,{.:#]|$)/.test(selector)
    || /\.budget\s+\.(?:track|fill)(?:[\s,{.:#]|$)/.test(selector);
}

function isControlSelector(selector) {
  return selector.split(",").some((part) => {
    const compounds = part.trim().split(/[\s>+~]+/);
    const target = compounds.at(-1) ?? "";
    return /^(?:button|\.btn(?:\b|[-:])|\.icon-btn\b|\.dl\b)/.test(target);
  });
}

/** Audit `{ file, source }` entries and summarize findings by rule. */
export function auditWebsiteSources(sources) {
  const findings = [];
  const add = (entry, match, rule, token) => findings.push({
    file: entry.file,
    line: lineOf(entry.source, match.index),
    rule,
    token: token.trim(),
  });

  for (const entry of sources) {
    for (const match of entry.source.matchAll(/font-size\s*:\s*([^;}"`]+)/g)) {
      const value = match[1].trim();
      const parsed = value.match(/^(10|12|14|16)px(?:\s*!important)?$/);
      if (!parsed || !TYPOGRAPHY_SIZES.has(parsed[1])) {
        add(entry, match, "nonStandardTypographySize", value);
      }
    }

    for (const match of entry.source.matchAll(/(?:^|[;{]\s*)font\s*:\s*(?:\d+\s+)?([\d.]+)px/gm)) {
      if (!TYPOGRAPHY_SIZES.has(match[1])) {
        add(entry, match, "nonStandardTypographyShorthand", `${match[1]}px`);
      }
    }

    for (const match of entry.source.matchAll(/border-radius\s*:\s*([^;}"`]+)/g)) {
      const value = match[1].trim();
      if (/^(?:10px|0\s*!important|var\(--radius\)(?:\s*!important)?)$/.test(value)) continue;
      if (value === "999px" && isSemanticCircle(selectorBefore(entry.source, match.index))) continue;
      add(entry, match, "nonStandardRadius", value);
    }

    for (const match of entry.source.matchAll(/(?:^|[;{]\s*)border\s*:\s*([^;}"`]+)/gm)) {
      const value = match[1].trim();
      if (/^0(?:\s*!important)?$/.test(value)) continue;
      add(entry, match, "restingFourSidedBorder", value);
    }

    for (const block of entry.source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = block[1].trim();
      if (!isControlSelector(selector)) continue;
      for (const match of block[2].matchAll(/(?:min-)?height\s*:\s*(\d+)px/g)) {
        if (CONTROL_SIZES.has(match[1])) continue;
        const absoluteIndex = block.index + block[0].indexOf("{") + 1 + match.index;
        add(entry, { index: absoluteIndex }, "nonStandardControlHeight", `${match[1]}px`);
      }
    }
  }

  const counts = findings.reduce((result, finding) => {
    result[finding.rule] = (result[finding.rule] ?? 0) + 1;
    return result;
  }, {});

  return { findings, counts };
}
