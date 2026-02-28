/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Light theme colors (Slack/Chatwork style)
        'editor-bg': '#ffffff',
        'sidebar-bg': '#f8f8f8',
        'activitybar-bg': '#f1f1f1',
        'panel-bg': '#ffffff',
        'border': '#e0e0e0',
        'text-primary': '#1d1c1d',
        'text-secondary': '#616061',
        'accent': '#1264a3', // Slack-like blue
        // Extended palette for refined UI
        'surface': {
          DEFAULT: '#ffffff',
          elevated: '#fafafa',
          overlay: 'rgba(0, 0, 0, 0.02)',
        },
        'ink': {
          DEFAULT: '#1d1c1d',
          muted: '#616061',
          faint: '#a0a0a0',
        },
        'glow': {
          accent: 'rgba(18, 100, 163, 0.1)',
          subtle: 'rgba(0, 0, 0, 0.02)',
        },
        // Dark theme colors
        'dark-surface': {
          DEFAULT: '#18181b',
          elevated: '#27272a',
          overlay: 'rgba(255, 255, 255, 0.02)',
        },
        'dark-ink': {
          DEFAULT: '#fafafa',
          muted: '#a1a1aa',
          faint: '#71717a',
        },
        'dark-border': '#3f3f46',
      },
      fontFamily: {
        sans: ['SF Pro Display', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      boxShadow: {
        'glass': '0 0 0 1px rgba(0, 0, 0, 0.05), 0 2px 8px rgba(0, 0, 0, 0.08)',
        'glow': '0 0 20px rgba(18, 100, 163, 0.15)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.8)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'noise': "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
      },
    },
  },
  plugins: [],
}
