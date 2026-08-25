import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Neutral clinical palette; tweak to your college's branding.
        ward: {
          DEFAULT: "#0f766e", // teal-700
          soft: "#ccfbf1",    // teal-100
        },
      },
    },
  },
  plugins: [],
};

export default config;
