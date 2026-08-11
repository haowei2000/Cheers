import type { Config } from "tailwindcss";

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
        sans: [
          '"Source Sans 3"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          "sans-serif",
        ],
        display: [
          '"Source Serif 4"',
          '"Source Han Serif CN"',
          '"Noto Serif SC"',
          '"Songti SC"',
          "Georgia",
          "serif",
        ],
        reading: [
          '"Source Serif 4"',
          '"Source Han Serif CN"',
          '"Noto Serif SC"',
          '"Songti SC"',
          "Georgia",
          "serif",
        ],
        utility: [
          '"Source Sans 3"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          "sans-serif",
        ],
      },
      colors: {
        rail: "#0f0f11",
        sidebar: "#18181b",
        indigo: editorialInk,
      },
      borderRadius: {
        sm: "var(--radius-control)",
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
