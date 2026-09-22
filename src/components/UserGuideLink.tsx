import { invoke, isTauri } from '@tauri-apps/api/core';
import { BookOpen } from 'lucide-react';
import { systemLogService } from '../services/systemLogService';

export function UserGuideLink() {
  return <a href="https://dekxdis.com/user-guide.html" target="_blank" rel="noopener noreferrer"
    className="btn-tactile flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-theme-primary text-xs font-medium"
    onClick={event => {
      if (!isTauri()) return;
      event.preventDefault();
      void invoke('open_dekxdis_guide').catch(error => systemLogService.logError('SYSTEM', 'Unable to open user guide', String(error)));
    }}>
    <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
    <span>User Guide</span>
  </a>;
}
