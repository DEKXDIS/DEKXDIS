export type ThemeId = 'blue-purple' | 'cyan-violet' | 'indigo-lavender' | 'gold-emerald' | 'synthwave';

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  description: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  primaryName: string;
  secondaryName: string;
  badgeBg: string;
  glowClass: string;
  previewGradient: string;
}

export const THEME_PRESETS: ThemeConfig[] = [
  {
    id: 'blue-purple',
    name: 'Electric Blue & Purple',
    description: 'Modern cybernetic styling with electric blue buy accents and neon purple sell accents.',
    primaryColor: '#3b82f6',
    secondaryColor: '#a855f7',
    accentColor: '#60a5fa',
    primaryName: 'Electric Blue',
    secondaryName: 'Neon Purple',
    badgeBg: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    glowClass: 'shadow-glow-blue',
    previewGradient: 'from-blue-500 via-indigo-500 to-purple-600',
  },
  {
    id: 'cyan-violet',
    name: 'Cyber Cyan & Violet',
    description: 'High-visibility neon cyan and royal violet trading interface.',
    primaryColor: '#06b6d4',
    secondaryColor: '#8b5cf6',
    accentColor: '#38bdf8',
    primaryName: 'Neon Cyan',
    secondaryName: 'Royal Violet',
    badgeBg: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    glowClass: 'shadow-glow-cyan',
    previewGradient: 'from-cyan-500 via-sky-500 to-violet-600',
  },
  {
    id: 'indigo-lavender',
    name: 'Deep Indigo & Lavender',
    description: 'Sleek dark theme with deep indigo structure and vibrant lavender accents.',
    primaryColor: '#6366f1',
    secondaryColor: '#c084fc',
    accentColor: '#818cf8',
    primaryName: 'Deep Indigo',
    secondaryName: 'Lavender',
    badgeBg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    glowClass: 'shadow-glow-indigo',
    previewGradient: 'from-indigo-500 via-purple-500 to-fuchsia-400',
  },
  {
    id: 'synthwave',
    name: 'Synthwave Neon',
    description: 'Vibrant 80s neon aesthetic with hot pink and electric cyan.',
    primaryColor: '#06b6d4',
    secondaryColor: '#ec4899',
    accentColor: '#f43f5e',
    primaryName: 'Electric Cyan',
    secondaryName: 'Hot Pink',
    badgeBg: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
    glowClass: 'shadow-glow-pink',
    previewGradient: 'from-cyan-400 via-pink-500 to-rose-500',
  },
  {
    id: 'gold-emerald',
    name: 'Classic Gold & Emerald',
    description: 'Original Binance Gold & Terminal Emerald color scheme.',
    primaryColor: '#F0B90B',
    secondaryColor: '#10b981',
    accentColor: '#f59e0b',
    primaryName: 'BNB Gold',
    secondaryName: 'Emerald',
    badgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    glowClass: 'shadow-glow-yellow',
    previewGradient: 'from-amber-400 via-yellow-500 to-emerald-500',
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'blue-purple';

export function getThemeConfig(id: ThemeId | string): ThemeConfig {
  return THEME_PRESETS.find((t) => t.id === id) || THEME_PRESETS[0];
}
