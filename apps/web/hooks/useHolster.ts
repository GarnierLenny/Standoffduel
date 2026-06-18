'use client';

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { loadHandLandmarker } from '@/lib/mediapipe';

export interface HolsterState {
  /** A hand is resting on the hip (down by the side) - the holstered pose. */
  holstered: boolean;
  /** That hand is shaped like a pistol (index out, others curled). */
  pistol: boolean;
}

export interface HandMarker {
  /** Palm-center, normalized to the raw (unmirrored) video frame. */
  x: number;
  y: number;
  holstered: boolean;
}

interface Options {
  video: HTMLVideoElement | null;
  /** Run detection at all (lobby + the moments around the draw). */
  active: boolean;
  /** Draw phase: fire `onDraw` the instant the hip hand leaves the holster. */
  armed: boolean;
  onHolsterChange?: (s: HolsterState) => void;
  onDraw: () => void;
}

type LM = { x: number; y: number };

// A wrist counts as "on the hip" when it's low in the frame and off to a side -
// exactly where your hand sits when it drops to a holster (works even if the
// webcam only sees your head and shoulders: the hand shows at a bottom corner).
const HOLSTER_Y = 0.58; // wrist low in the frame (down toward the hip)
const SIDE_X = 0.35; // ...and clearly out to a side, not resting centrally
const HOLD_MS = 600; // hold the pose this long to ready (kills accidental triggers)
const DRAW_MOVE = 0.06; // armed: wrist moving this far (of frame) in ~260ms = draw

function wristHolstered(hand: LM[]): boolean {
  const w = hand[0];
  return w.y > HOLSTER_Y && (w.x < SIDE_X || w.x > 1 - SIDE_X);
}

// Index finger extended, the other three curled - a finger-gun.
function isPistol(hand: LM[]): boolean {
  const wrist = hand[0];
  const d = (a: LM, b: LM) => Math.hypot(a.x - b.x, a.y - b.y);
  const extended = (tip: number, pip: number) =>
    d(hand[tip], wrist) > d(hand[pip], wrist) * 1.2;
  return (
    extended(8, 6) &&
    !extended(12, 10) &&
    !extended(16, 14) &&
    !extended(20, 18)
  );
}

/**
 * Webcam holster mechanic. Watches the local hands and reports when one is
 * "holstered" (on the hip) so the player auto-readies, then fires the draw the
 * moment that hand is pulled away from the hip after the signal.
 */
export function useHolster({
  video,
  active,
  armed,
  onHolsterChange,
  onDraw,
}: Options): MutableRefObject<HandMarker[]> {
  const markerRef = useRef<HandMarker[]>([]);
  const armedRef = useRef(armed);
  const onDrawRef = useRef(onDraw);
  const onChangeRef = useRef(onHolsterChange);
  armedRef.current = armed;
  onDrawRef.current = onDraw;
  onChangeRef.current = onHolsterChange;

  useEffect(() => {
    if (!video || !active) return;
    let raf = 0;
    let stopped = false;
    let lastVideoTime = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let landmarker: any = null;

    let holsterStart = 0;
    let lastInZoneT = 0;
    let holsteredStable = false;
    let armedPrev = false;
    let drawn = false;
    const moveHist: { t: number; d: number }[] = [];

    (async () => {
      try {
        landmarker = await loadHandLandmarker();
      } catch {
        return; // model failed; manual Ready + tap/SPACE still work
      }
      if (stopped) return;

      const loop = () => {
        if (stopped) return;
        raf = requestAnimationFrame(loop);
        if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;

        let result;
        try {
          result = landmarker.detectForVideo(video, performance.now());
        } catch {
          return;
        }
        const hands: LM[][] = result?.landmarks ?? [];
        const now = performance.now();

        // One circle per hand (up to 2): each palm centre + whether it's on the
        // hip. Smooth toward the nearest previous marker so the two circles
        // don't swap or jitter between hands.
        let pistol = false;
        let anyHolstered = false;
        const current = hands.map((h) => {
          const ids = [0, 5, 9, 13, 17];
          let cx = 0;
          let cy = 0;
          for (const i of ids) {
            cx += h[i].x;
            cy += h[i].y;
          }
          const holstered = wristHolstered(h);
          if (holstered) anyHolstered = true;
          if (isPistol(h)) pistol = true;
          return { x: cx / ids.length, y: cy / ids.length, holstered };
        });

        const prev = markerRef.current;
        const used = new Array(prev.length).fill(false);
        let frameMaxDisp = 0;
        markerRef.current = current.map((c) => {
          let best = -1;
          let bestD = Infinity;
          for (let j = 0; j < prev.length; j++) {
            if (used[j]) continue;
            const d = Math.hypot(prev[j].x - c.x, prev[j].y - c.y);
            if (d < bestD) {
              bestD = d;
              best = j;
            }
          }
          if (best >= 0 && bestD < 0.18) {
            used[best] = true;
            frameMaxDisp = Math.max(frameMaxDisp, bestD);
            return {
              x: prev[best].x * 0.5 + c.x * 0.5,
              y: prev[best].y * 0.5 + c.y * 0.5,
              holstered: c.holstered,
            };
          }
          return c;
        });

        // Must HOLD a hand on the hip for HOLD_MS to ready.
        if (anyHolstered) {
          lastInZoneT = now;
          if (holsterStart === 0) holsterStart = now;
        } else if (now - lastInZoneT > 150) {
          holsterStart = 0;
        }
        const nextStable = holsterStart !== 0 && now - holsterStart > HOLD_MS;
        if (nextStable !== holsteredStable) {
          holsteredStable = nextStable;
          onChangeRef.current?.({ holstered: holsteredStable, pistol });
        }

        // Draw: once armed, the FIRST hand to move quickly fires it. Track the
        // fastest hand's travel over a short window (works with one or two hands).
        moveHist.push({ t: now, d: frameMaxDisp });
        while (moveHist.length && now - moveHist[0].t > 260) moveHist.shift();
        const armedNow = armedRef.current;
        if (armedNow && !armedPrev) {
          drawn = false;
          moveHist.length = 0;
        }
        armedPrev = armedNow;
        if (armedNow && !drawn) {
          const traveled = moveHist.reduce((s, m) => s + m.d, 0);
          if (traveled > DRAW_MOVE) {
            drawn = true;
            onDrawRef.current();
          }
        }
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [video, active]);

  return markerRef;
}
