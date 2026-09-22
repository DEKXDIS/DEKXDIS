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
        background: '#0a0d14',
        surface: '#111622',
        'surface-hover': '#182030',
        'surface-border': '#1e293b',
        'terminal-green': '#10b981',
        'terminal-red': '#f43f5e',
        'bnb-yellow': '#F0B90B',
        'cow-blue': '#1e40af',
        'cow-cyan': '#06b6d4',
        'theme-primary': 'var(--theme-primary)',
        'theme-primary-hover': 'var(--theme-primary-hover)',
        'theme-secondary': 'var(--theme-secondary)',
        'theme-secondary-hover': 'var(--theme-secondary-hover)',
        'theme-accent': 'var(--theme-accent)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Roboto Mono', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'glow-yellow': '0 0 20px -5px rgba(240, 185, 11, 0.3)',
        'glow-green': '0 0 20px -5px rgba(16, 185, 129, 0.3)',
        'glow-cyan': '0 0 20px -5px rgba(6, 182, 212, 0.3)',
        'glow-red': '0 0 20px -5px rgba(244, 63, 94, 0.3)',
        'glow-primary': '0 0 20px -5px var(--theme-glow-primary)',
        'glow-secondary': '0 0 20px -5px var(--theme-glow-secondary)',
        'glow-blue': '0 0 20px -5px rgba(59, 130, 246, 0.4)',
        'glow-purple': '0 0 20px -5px rgba(168, 85, 247, 0.4)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ping-slow': 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite',
      }
    },
  },
  plugins: [],
}
