import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Minus, Square, Maximize2 } from 'lucide-react';
import { fitWindowToBounds } from '../utils/windowBounds';

export interface WindowLayout {
  id: string;
  title: string;
  icon?: React.ReactNode;
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  zIndex: number;
  isMinimized?: boolean;
  isMaximized?: boolean;
}

interface DraggableResizableWindowProps {
  layout: WindowLayout;
  onUpdateLayout: (id: string, updates: Partial<WindowLayout>) => void;
  onBringToFront: (id: string) => void;
  containerBounds?: { width: number; height: number };
  children: React.ReactNode;
}

export const DraggableResizableWindow: React.FC<DraggableResizableWindowProps> = ({
  layout,
  onUpdateLayout,
  onBringToFront,
  containerBounds,
  children,
}) => {
  const {
    id,
    title,
    icon,
    x,
    y,
    width,
    height,
    minWidth = 280,
    minHeight = 180,
    zIndex,
    isMinimized = false,
    isMaximized = false,
  } = fitWindowToBounds(layout, containerBounds);

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState<string | null>(null);

  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0,
  });

  const resizeStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
  });

  const prevLayoutRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Drag Handlers
  const handleDragStart = (e: React.PointerEvent) => {
    if (isMaximized) return;
    if ((e.target as HTMLElement).closest('button')) return;

    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onBringToFront(id);
    setIsDragging(true);

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: x,
      startY: y,
    };
  };

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (isDragging) {
      const deltaX = e.clientX - dragStartRef.current.mouseX;
      const deltaY = e.clientY - dragStartRef.current.mouseY;

      let newX = dragStartRef.current.startX + deltaX;
      let newY = dragStartRef.current.startY + deltaY;

      if (containerBounds) {
        newX = Math.max(0, Math.min(newX, containerBounds.width - width));
        newY = Math.max(0, Math.min(newY, containerBounds.height - (isMinimized ? 40 : height)));
      } else {
        newX = Math.max(0, newX);
        newY = Math.max(0, newY);
      }

      onUpdateLayout(id, { x: newX, y: newY });
    } else if (isResizing) {
      const deltaX = e.clientX - resizeStartRef.current.mouseX;
      const deltaY = e.clientY - resizeStartRef.current.mouseY;

      let newWidth = resizeStartRef.current.startWidth;
      let newHeight = resizeStartRef.current.startHeight;
      let newX = resizeStartRef.current.startX;
      let newY = resizeStartRef.current.startY;

      if (isResizing.includes('e')) {
        newWidth = Math.max(minWidth, resizeStartRef.current.startWidth + deltaX);
      }
      if (isResizing.includes('s')) {
        newHeight = Math.max(minHeight, resizeStartRef.current.startHeight + deltaY);
      }
      if (isResizing.includes('w')) {
        const potentialWidth = resizeStartRef.current.startWidth - deltaX;
        if (potentialWidth >= minWidth) {
          newWidth = potentialWidth;
          newX = resizeStartRef.current.startX + deltaX;
        }
      }
      if (isResizing.includes('n')) {
        const potentialHeight = resizeStartRef.current.startHeight - deltaY;
        if (potentialHeight >= minHeight) {
          newHeight = potentialHeight;
          newY = resizeStartRef.current.startY + deltaY;
        }
      }

      onUpdateLayout(id, {
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight,
      });
    }
  }, [isDragging, isResizing, containerBounds, id, minWidth, minHeight, onUpdateLayout, width, height, isMinimized]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(null);
  }, []);

  useEffect(() => {
    if (isDragging || isResizing) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };
    }
  }, [isDragging, isResizing, handlePointerMove, handlePointerUp]);

  const handleResizeStart = (direction: string, e: React.PointerEvent) => {
    if (isMaximized || isMinimized) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onBringToFront(id);
    setIsResizing(direction);

    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: x,
      startY: y,
      startWidth: width,
      startHeight: height,
    };
  };

  const toggleMaximize = () => {
    onBringToFront(id);

    // On a minimized window this control means "restore", not "maximize".
    // Keep the saved geometry (and maximized state, if it had one) intact.
    if (isMinimized) {
      onUpdateLayout(id, { isMinimized: false });
      return;
    }

    if (!isMaximized) {
      prevLayoutRef.current = { x, y, width, height };
      if (containerBounds) {
        onUpdateLayout(id, {
          x: 0,
          y: 0,
          width: containerBounds.width,
          height: containerBounds.height,
          isMaximized: true,
          isMinimized: false,
        });
      }
    } else {
      const prev = prevLayoutRef.current;
      onUpdateLayout(id, {
        x: prev ? prev.x : x,
        y: prev ? prev.y : y,
        width: prev ? prev.width : width,
        height: prev ? prev.height : height,
        isMaximized: false,
      });
    }
  };

  const toggleMinimize = () => {
    onBringToFront(id);
    onUpdateLayout(id, {
      isMinimized: !isMinimized,
    });
  };

  const style: React.CSSProperties = isMinimized
    ? {
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: '40px',
        zIndex: isMaximized ? zIndex + 100 : zIndex,
      }
    : isMaximized
    ? {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: zIndex + 100,
      }
    : {
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        zIndex,
      };

  return (
    <div
      style={style}
      onPointerDown={() => onBringToFront(id)}
      className={`rounded-xl border border-surface-border bg-surface shadow-2xl flex flex-col overflow-hidden transition-[box-shadow] select-none ${
        isDragging ? 'shadow-glow-cyan ring-1 ring-cow-cyan/40 cursor-move' : ''
      }`}
    >
      {/* WINDOW TITLEBAR / DRAG HANDLE */}
      <div
        onPointerDown={handleDragStart}
        className="h-9 px-3 bg-surface-hover/90 border-b border-surface-border flex items-center justify-between cursor-move shrink-0 active:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 pr-2 pointer-events-none">
          {icon && <span className="shrink-0 text-slate-400">{icon}</span>}
          <span className="text-xs font-bold text-slate-200 truncate tracking-wide font-mono">
            {title}
          </span>
        </div>

        {/* Window Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={toggleMinimize}
            aria-label={isMinimized ? 'Restore window' : 'Minimize window'}
            className="p-1 rounded hover:bg-slate-700/60 text-slate-400 hover:text-white transition-colors"
            title={isMinimized ? 'Restore Window' : 'Minimize Window'}
          >
            {isMinimized ? <Square className="w-2.5 h-2.5" /> : <Minus className="w-3 h-3" />}
          </button>
          <button
            onClick={toggleMaximize}
            aria-label={isMinimized ? 'Restore window' : isMaximized ? 'Restore size' : 'Maximize window'}
            className="p-1 rounded hover:bg-slate-700/60 text-slate-400 hover:text-white transition-colors"
            title={isMinimized ? 'Restore Window' : isMaximized ? 'Restore Size' : 'Maximize Window'}
          >
            {isMinimized || isMaximized ? <Square className="w-2.5 h-2.5" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* WINDOW CONTENT AREA */}
      {!isMinimized && (
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col p-1 select-text">
          {children}
        </div>
      )}

      {/* RESIZE HANDLES */}
      {!isMaximized && !isMinimized && (
        <>
          {/* Bottom-Right Corner Handle */}
          <div
            onPointerDown={(e) => handleResizeStart('se', e)}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-end justify-end p-0.5 z-30 group"
          >
            <div className="w-2 h-2 border-r-2 border-b-2 border-slate-500 group-hover:border-bnb-yellow transition-colors" />
          </div>

          {/* Right Edge Handle */}
          <div
            onPointerDown={(e) => handleResizeStart('e', e)}
            className="absolute top-9 right-0 w-2 h-[calc(100%-18px)] cursor-e-resize z-20 hover:bg-cow-cyan/30 transition-colors"
          />

          {/* Bottom Edge Handle */}
          <div
            onPointerDown={(e) => handleResizeStart('s', e)}
            className="absolute bottom-0 left-0 h-2 w-[calc(100%-18px)] cursor-s-resize z-20 hover:bg-cow-cyan/30 transition-colors"
          />

          {/* Left Edge Handle */}
          <div
            onPointerDown={(e) => handleResizeStart('w', e)}
            className="absolute top-9 left-0 w-2 h-[calc(100%-18px)] cursor-w-resize z-20 hover:bg-cow-cyan/30 transition-colors"
          />

          {/* Top Edge Handle */}
          <div
            onPointerDown={(e) => handleResizeStart('n', e)}
            className="absolute top-0 left-0 h-2 w-full cursor-n-resize z-20 hover:bg-cow-cyan/30 transition-colors"
          />
        </>
      )}
    </div>
  );
};
