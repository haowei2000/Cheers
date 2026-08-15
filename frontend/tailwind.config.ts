import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// The product historically used Tailwind's electric indigo as its default
// accent. Keep the semantic class name while existing call sites migrate, but
// map it to a neutral ink scale so focus, selection, and primary actions remain
// visible without turning every interaction into a neon highlight.
const editorialInk = {
  50: "#fafafa",
  100: "#f4f4f5",
  200: "#e4e4e7",
  300: "#d4d4d8",
  400: "#a1a1aa",
  500: "#71717a",
  600: "#52525b",
  700: "#3f3f46",
  800: "#27272a",
  900: "#18181b",
  950: "#09090b",
};

const editorialNeutral = {
  ...colors.zinc,
  400: "#b4b4bc",
  500: "#95959e",
  600: "#85858f",
  700: "#4a4a52",
  800: "#303035",
  900: "#1c1c20",
};

function rgbChannels(hex: string): string {
  const value = hex.replace("#", "");
  return `${Number.parseInt(value.slice(0, 2), 16)} ${Number.parseInt(value.slice(2, 4), 16)} ${Number.parseInt(value.slice(4, 6), 16)}`;
}

function themedScale(name: string, palette: Record<string | number, string>) {
  return Object.fromEntries(
    Object.entries(palette).map(([shade, fallback]) => [
      shade,
      `rgb(var(--tone-${name}-${shade}, ${rgbChannels(fallback)}) / <alpha-value>)`,
    ]),
  );
}

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-ui)"],
        display: ["var(--font-serif)"],
        masthead: ["var(--font-serif)"],
        reading: ["var(--font-serif)"],
        utility: ["var(--font-ui)"],
      },
      fontSize: {
        minimal: ["var(--type-minimal-size)", { lineHeight: "var(--type-minimal-leading)", letterSpacing: "var(--type-minimal-tracking)" }],
        compact: ["var(--type-compact-size)", { lineHeight: "var(--type-compact-leading)", letterSpacing: "var(--type-compact-tracking)" }],
        regular: ["var(--type-regular-size)", { lineHeight: "var(--type-regular-leading)", letterSpacing: "var(--type-regular-tracking)" }],
        comfortable: ["var(--type-comfortable-size)", { lineHeight: "var(--type-comfortable-leading)", letterSpacing: "var(--type-comfortable-tracking)" }],
      },
      fontWeight: {
        normal: "var(--weight-regular)",
        medium: "var(--weight-medium)",
        semibold: "var(--weight-semibold)",
        bold: "var(--weight-bold)",
      },
      letterSpacing: {
        display: "var(--tracking-display)",
        masthead: "var(--tracking-masthead)",
        label: "var(--tracking-label)",
        section: "var(--tracking-section)",
        overline: "var(--tracking-overline)",
      },
      lineHeight: {
        flat: "var(--leading-flat)",
        heading: "var(--leading-heading)",
        regular: "var(--leading-regular)",
        reading: "var(--leading-reading)",
        masthead: "var(--leading-masthead)",
      },
      colors: {
        content: {
          strong: "rgb(var(--text-strong) / <alpha-value>)",
          primary: "rgb(var(--text-primary) / <alpha-value>)",
          secondary: "rgb(var(--text-secondary) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          "on-light": "rgb(var(--text-on-light) / <alpha-value>)",
          "on-accent": "rgb(var(--text-on-accent) / <alpha-value>)",
        },
        accent: themedScale("ink", editorialInk),
        danger: themedScale("danger", colors.red),
        warning: themedScale("warning", colors.amber),
        success: themedScale("success", colors.emerald),
        removed: themedScale("removed", colors.rose),
        info: themedScale("info", colors.sky),
        stale: themedScale("stale", colors.orange),
        research: themedScale("research", colors.violet),
        category: themedScale("category", colors.teal),
        rail: "rgb(var(--surface-rail) / <alpha-value>)",
        sidebar: "rgb(var(--surface-sidebar) / <alpha-value>)",
        canvas: "rgb(var(--surface-canvas) / <alpha-value>)",
        panel: "rgb(var(--surface-panel) / <alpha-value>)",
        control: {
          DEFAULT: "rgb(var(--surface-control) / <alpha-value>)",
          hover: "rgb(var(--surface-control-hover) / <alpha-value>)",
          active: "rgb(var(--surface-control-active) / <alpha-value>)",
        },
        emphasis: {
          DEFAULT: "rgb(var(--surface-emphasis) / <alpha-value>)",
          hover: "rgb(var(--surface-emphasis-hover) / <alpha-value>)",
          active: "rgb(var(--surface-emphasis-active) / <alpha-value>)",
        },
        indigo: themedScale("ink", editorialInk),
        red: themedScale("danger", colors.red),
        amber: themedScale("warning", colors.amber),
        emerald: themedScale("success", colors.emerald),
        rose: themedScale("removed", colors.rose),
        sky: themedScale("info", colors.sky),
        orange: themedScale("stale", colors.orange),
        violet: themedScale("research", colors.violet),
        teal: themedScale("category", colors.teal),
        // The product uses compact utility copy extensively, especially in
        // Settings. Lift the quiet text tiers well above AA and separate card,
        // field and divider surfaces from zinc-950 without losing hierarchy.
        zinc: themedScale("zinc", editorialNeutral),
      },
      borderRadius: {
        sm: "var(--radius-control)",
        concentric: "calc(var(--radius-control) + var(--concentric-inset, 0px))",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.15s ease-out",
        blink: "blink 1s step-end infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
