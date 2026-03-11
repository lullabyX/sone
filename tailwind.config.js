/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        th: {
          base: "var(--th-bg-base)",
          surface: "var(--th-bg-surface)",
          "surface-hover": "var(--th-bg-surface-hover)",
          elevated: "var(--th-bg-elevated)",
          sidebar: "var(--th-bg-sidebar)",
          overlay: "var(--th-bg-overlay)",
          inset: "var(--th-bg-inset)",
          "inset-hover": "var(--th-bg-inset-hover)",
          button: "var(--th-bg-button)",
          "button-hover": "var(--th-bg-button-hover)",
          accent: "var(--th-accent)",
          "accent-hover": "var(--th-accent-hover)",
          "text-primary": "var(--th-text-primary)",
          "text-secondary": "var(--th-text-secondary)",
          "text-muted": "var(--th-text-muted)",
          "text-faint": "var(--th-text-faint)",
          "text-disabled": "var(--th-text-disabled)",
          "border-subtle": "var(--th-border-subtle)",
          success: "var(--th-success)",
          error: "var(--th-error)",
          warning: "var(--th-warning)",
          "hl-faint": "var(--th-hl-faint)",
          "hl-med": "var(--th-hl-med)",
          "hl-strong": "var(--th-hl-strong)",
          "slider-track": "var(--th-slider-track)",
          "slider-fill": "var(--th-slider-fill)",
        },
      },
    },
  },
  plugins: [],
};
