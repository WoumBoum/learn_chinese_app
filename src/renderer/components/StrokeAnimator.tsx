// Stroke-order animation with Hanzi Writer, fed by the local Make Me a Hanzi data (no network).
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import HanziWriter from 'hanzi-writer';
import { call } from '../api';

export interface StrokeAnimatorHandle {
  animate: () => void;
  nextStroke: () => void;
  reset: () => void;
  showFull: () => void;
  hide: () => void;
}

interface Props {
  char: string;
  size?: number;
  autoAnimate?: boolean;
  showOutline?: boolean;
  grid?: boolean;
  speed?: number;
  numbered?: boolean;
}

const cache = new Map<string, unknown>();
async function load(c: string) {
  if (cache.has(c)) return cache.get(c);
  const d = await call('core:strokes', c);
  cache.set(c, d);
  return d;
}

export const StrokeAnimator = forwardRef<StrokeAnimatorHandle, Props>(function StrokeAnimator(
  { char, size = 220, autoAnimate = true, showOutline = true, grid = true, speed = 1, numbered = false },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const writer = useRef<HanziWriter | null>(null);
  const step = useRef(0);
  const [missing, setMissing] = useState(false);
  const [nStrokes, setN] = useState(0);
  const [medians, setMedians] = useState<number[][][]>([]);

  useEffect(() => {
    setMissing(false);
    if (!el.current) return;
    el.current.innerHTML = '';
    step.current = 0;
    let cancelled = false;
    load(char).then((data) => {
      if (cancelled || !el.current) return;
      if (!data) {
        setMissing(true);
        return;
      }
      const d = data as { strokes: string[]; medians: number[][][] };
      setN(d.strokes.length);
      setMedians(d.medians);
      writer.current = HanziWriter.create(el.current, char, {
        width: size,
        height: size,
        padding: 6,
        showOutline,
        strokeColor: '#e6edf3',
        outlineColor: '#33414e',
        radicalColor: '#e5484d',
        delayBetweenStrokes: 250 / speed,
        strokeAnimationSpeed: speed,
        charDataLoader: (_c, onLoad) => onLoad(d as never),
      });
      if (autoAnimate) writer.current.animateCharacter();
    });
    return () => {
      cancelled = true;
    };
  }, [char, size, showOutline, autoAnimate, speed]);

  useImperativeHandle(ref, () => ({
    animate: () => {
      step.current = 0;
      writer.current?.hideCharacter();
      writer.current?.animateCharacter();
    },
    nextStroke: () => {
      if (!writer.current) return;
      if (step.current === 0) writer.current.hideCharacter();
      if (step.current >= nStrokes) {
        step.current = 0;
        writer.current.hideCharacter();
        return;
      }
      writer.current.animateStroke(step.current);
      step.current++;
    },
    reset: () => {
      step.current = 0;
      writer.current?.hideCharacter();
    },
    showFull: () => writer.current?.showCharacter(),
    hide: () => writer.current?.hideCharacter(),
  }));

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {grid && <TianGrid size={size} />}
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {missing && (
        <div className="hanzi" style={{ position: 'absolute', inset: 0, fontSize: size * 0.8, display: 'grid', placeItems: 'center' }}>
          {char}
        </div>
      )}
      {numbered && medians.length > 0 && (
        <svg width={size} height={size} viewBox="0 0 1024 1024" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <g transform="scale(1,-1) translate(0,-900)">
            {medians.map((m, i) => (
              <g key={i} transform={`translate(${m[0][0]},${m[0][1]}) scale(1,-1)`}>
                <circle r="38" fill="#e5484d" opacity="0.9" />
                <text textAnchor="middle" dy="14" fontSize="44" fill="#fff" fontFamily="sans-serif">
                  {i + 1}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  );
});

/** 田字格 grid (the square used for handwriting practice). */
export function TianGrid({ size }: { size: number }) {
  return (
    <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
      <rect x="1" y="1" width={size - 2} height={size - 2} fill="none" stroke="#3a4a58" strokeWidth="2" />
      <line x1={size / 2} y1="0" x2={size / 2} y2={size} stroke="#2c3a47" strokeDasharray="6 6" />
      <line x1="0" y1={size / 2} x2={size} y2={size / 2} stroke="#2c3a47" strokeDasharray="6 6" />
      <line x1="0" y1="0" x2={size} y2={size} stroke="#232f3a" strokeDasharray="4 8" />
      <line x1={size} y1="0" x2="0" y2={size} stroke="#232f3a" strokeDasharray="4 8" />
    </svg>
  );
}
