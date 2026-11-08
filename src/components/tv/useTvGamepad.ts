import { useEffect, useRef } from "react";
import { dispatchTvKey, heldKeys, padKeys, readPads } from "./tvGamepad";

const TV_PAD_REPEAT_DELAY_MS = 400;
const TV_PAD_REPEAT_MS = 110;
const REPEATS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "AudioVolumeUp",
  "AudioVolumeDown",
]);

/**
 * Turns gamepad input into the keys a remote sends. Polls once a frame
 * while a pad is connected; held arrows and volume repeat like a held
 * remote key.
 */
export function useTvGamepad(enabled: boolean): void {
  const held = useRef(new Set<string>());
  const repeatAt = useRef(new Map<string, number>());
  const triggerAxes = useRef(new Map<string, Set<number>>());

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== "function") return;
    let frame: number | null = null;
    const pads = () => navigator.getGamepads?.() ?? [];

    const release = () => {
      for (const key of held.current) dispatchTvKey("keyup", key);
      held.current = new Set();
      repeatAt.current.clear();
    };
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      const next = heldKeys(
        readPads(pads(), triggerAxes.current),
        held.current,
      );
      const { down, up } = padKeys(held.current, next);
      held.current = next;
      const now = performance.now();
      for (const key of up) {
        repeatAt.current.delete(key);
        dispatchTvKey("keyup", key);
      }
      for (const [key, at] of repeatAt.current) {
        if (now < at) continue;
        repeatAt.current.set(key, now + TV_PAD_REPEAT_MS);
        dispatchTvKey("keydown", key, true);
      }
      for (const key of down) {
        if (REPEATS.has(key)) {
          repeatAt.current.set(key, now + TV_PAD_REPEAT_DELAY_MS);
        }
        dispatchTvKey("keydown", key);
      }
    };
    const start = () => {
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      release();
    };
    const onDisconnect = (e: Event) => {
      const gone = (e as GamepadEvent).gamepad;
      const left = pads().some(
        (p) => p && p.connected !== false && p.index !== gone?.index,
      );
      if (!left) stop();
    };

    if (pads().some(Boolean)) start();
    window.addEventListener("gamepadconnected", start);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", start);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      stop();
    };
  }, [enabled]);
}
