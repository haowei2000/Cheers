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
        mono: ["var(--font-mono)"],
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
        accent: editorialInk,
        danger: colors.red,
        warning: colors.amber,
        success: colors.emerald,
        removed: colors.rose,
        info: colors.sky,
        stale: colors.orange,
        research: colors.violet,
        category: colors.teal,
        rail: "#0f0f11",
        sidebar: "#18181b",
        indigo: editorialInk,
        // The product uses compact utility copy extensively, especially in
        // Settings. Lift the quiet text tiers well above AA and separate card,
        // field and divider surfaces from zinc-950 without losing hierarchy.
        zinc: {
          400: "#b4b4bc",
          500: "#95959e",
          600: "#85858f",
          700: "#4a4a52",
          800: "#303035",
          900: "#1c1c20",
        },
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
