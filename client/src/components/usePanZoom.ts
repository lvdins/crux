import { useEffect, useRef, useState } from "react";

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Wheel-zoom toward cursor + drag-pan for an SVG, via viewBox manipulation. */
export function usePanZoom(W: number, H: number) {
  const [view, setView] = useState<ViewBox>({ x: 0, y: 0, w: W, h: H });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; view: ViewBox; moved: boolean } | null>(null);

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    setView((v) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const fx = rect && clientX != null ? (clientX - rect.left) / rect.width : 0.5;
      const fy = rect && clientY != null ? (clientY - rect.top) / rect.height : 0.5;
      const px = v.x + fx * v.w;
      const py = v.y + fy * v.h;
      const w = Math.min(W * 4, Math.max(W / 10, v.w * factor));
      const h = (w / W) * H;
      return { x: px - fx * w, y: py - fy * h, w, h };
    });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(Math.max(-80, Math.min(80, e.deltaY)) * 0.001);
      zoomAt(factor, e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { px: e.clientX, py: e.clientY, view, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) {
      setView({
        ...d.view,
        x: d.view.x - (dx / rect.width) * d.view.w,
        y: d.view.y - (dy / rect.height) * d.view.h,
      });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const reset = () => setView({ x: 0, y: 0, w: W, h: H });
  const isPanning = () => !!drag.current?.moved;

  return { view, svgRef, zoomAt, reset, isPanning, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp } };
}
