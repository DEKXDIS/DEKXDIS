import { ModalDialog } from './ModalDialog';
import React from 'react';
import { X, Palette, Check, Sparkles } from 'lucide-react';
import { ThemeId, THEME_PRESETS, getThemeConfig } from '../types/theme';

interface ThemeSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: ThemeId;
  onSelectTheme: (themeId: ThemeId) => void;
}

export const ThemeSelectorModal: React.FC<ThemeSelectorModalProps> = ({
  isOpen,
  onClose,
  currentTheme,
  onSelectTheme,
}) => {
  if (!isOpen) return null;

  return (
    <ModalDialog label="Select theme" onClose={onClose} busy={false}>
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150 select-text">
      <div className="bg-surface border border-surface-border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-hover/30 shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-theme-primary-10 text-theme-primary">
              <Palette className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-white">Color Schemes & Themes</h3>
              <p className="text-[11px] text-slate-400">Select your preferred terminal theme and accent colors</p>
            </div>
          </div>
          <button
            aria-label="Close" disabled={false} onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-border transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Theme List */}
        <div className="p-5 space-y-3 overflow-y-auto">
          {THEME_PRESETS.map((theme) => {
            const isSelected = theme.id === currentTheme;
            return (
              <div
                key={theme.id}
                onClick={() => onSelectTheme(theme.id)}
                className={`btn-tactile p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-4 ${
                  isSelected
                    ? 'bg-slate-900 border-theme-primary shadow-glow-primary'
                    : 'bg-background/80 border-surface-border hover:border-slate-600 hover:bg-slate-900/60'
                }`}
              >
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-white tracking-tight">{theme.name}</span>
                    {theme.id === 'blue-purple' && (
                      <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-theme-primary-10 text-theme-primary font-semibold border border-theme-primary-30">
                        DEFAULT
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-snug">
                    {theme.description}
                  </p>
                  
                  {/* Swatches */}
                  <div className="flex items-center gap-2 pt-1 font-mono text-[10px]">
                    <div className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded-full border border-white/20 shadow-sm" style={{ backgroundColor: theme.primaryColor }}></span>
                      <span className="text-slate-300">{theme.primaryName}</span>
                    </div>
                    <span className="text-slate-600">·</span>
                    <div className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded-full border border-white/20 shadow-sm" style={{ backgroundColor: theme.secondaryColor }}></span>
                      <span className="text-slate-300">{theme.secondaryName}</span>
                    </div>
                  </div>
                </div>

                {/* Preview Gradient Bar & Selection Icon */}
                <div className="flex items-center gap-3 shrink-0">
                  <div className={`w-16 h-8 rounded-lg bg-gradient-to-r ${theme.previewGradient} shadow-inner border border-white/10`}></div>
                  
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center border transition-all ${
                    isSelected
                      ? 'bg-theme-primary border-theme-primary text-slate-950 font-bold'
                      : 'border-slate-700 bg-slate-950/60 text-transparent'
                  }`}>
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-surface-border bg-surface-hover/20 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-400 font-mono">
            <Sparkles className="w-3.5 h-3.5 text-theme-primary" />
            <span>Active: <strong className="text-white">{getThemeConfig(currentTheme).name}</strong></span>
          </div>
          <button
            onClick={onClose}
            className="btn-tactile px-6 py-2 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-xs shadow-glow-primary transition-all cursor-pointer"
          >
            Done
          </button>
        </div>

      </div>
    </div>
    </ModalDialog>
  );
};
