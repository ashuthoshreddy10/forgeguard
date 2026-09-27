/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      colors: {
        surface: {
          900: '#0d0f14',
          800: '#141720',
          700: '#1c202e',
          600: '#252b3d',
          500: '#2f3650',
        },
        accent: {
          blue: '#3b82f6',
          green: '#22c55e',
          amber: '#f59e0b',
          red: '#ef4444',
          purple: '#a855f7',
          cyan: '#06b6d4',
        },
      },
    },
  },
  plugins: [],
};
