"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NAIJA_POPUP_EVENT, takePendingNaijaPopup, type NaijaPopupRequest } from "@/lib/naija/popup-bus";

/** Total life of a pop-up. It is fully gone from the DOM at exactly this time. */
export const NAIJA_POPUP_MS = 5000;
const EXIT_MS = 300; // exit animation runs inside the 5 s, so nothing is visible after 5.000 s

const ACCENT: Record<NaijaPopupRequest["kind"], { ring: string; glow: string; label: string; icon: string }> = {
  login: { ring: "#34d399", glow: "rgba(52,211,153,.35)", label: "Welcome back", icon: "🎱" },
  register: { ring: "#34d399", glow: "rgba(52,211,153,.35)", label: "New champion", icon: "🎉" },
  win: { ring: "#fbbf24", glow: "rgba(251,191,36,.4)", label: "Victory", icon: "🏆" },
  loss: { ring: "#94a3b8", glow: "rgba(148,163,184,.3)", label: "Next round", icon: "💪" },
};

type Shown = NaijaPopupRequest & { id: number };

/** Mount once (root layout). Shows one pop-up at a time; a new one replaces the current one. */
export default function NaijaPopupHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [leaving, setLeaving] = useState(false);
  const idRef = useRef(0);
  const currentKey = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setLeaving(true);
    timers.current.push(window.setTimeout(() => { setShown(null); setLeaving(false); currentKey.current = null; }, EXIT_MS));
  }, [clearTimers]);

  const show = useCallback((req: NaijaPopupRequest) => {
    if (currentKey.current === req.key) return; // duplicate event for the pop-up already on screen
    clearTimers();
    currentKey.current = req.key;
    idRef.current += 1;
    setLeaving(false);
    setShown({ ...req, id: idRef.current });
    // exit animation starts at 5 s - EXIT_MS and the element is removed at exactly 5 s
    timers.current.push(window.setTimeout(() => setLeaving(true), NAIJA_POPUP_MS - EXIT_MS));
    timers.current.push(window.setTimeout(() => { setShown(null); setLeaving(false); currentKey.current = null; }, NAIJA_POPUP_MS));
  }, [clearTimers]);

  useEffect(() => {
    const pending = takePendingNaijaPopup();
    if (pending) show(pending);
    const onEvent = (e: Event) => { const d = (e as CustomEvent<NaijaPopupRequest>).detail; if (d?.message) show(d); };
    window.addEventListener(NAIJA_POPUP_EVENT, onEvent);
    return () => { window.removeEventListener(NAIJA_POPUP_EVENT, onEvent); clearTimers(); };
  }, [show, clearTimers]);

  if (!shown) return null;
  const a = ACCENT[shown.kind];
  return (
    <>
      <style>{CSS}</style>
      <div className="sbn-wrap" aria-live="polite" role="status">
        <div
          key={shown.id}
          className={`sbn-card${leaving ? " sbn-leave" : ""}`}
          style={{ ["--sbn-ring" as string]: a.ring, ["--sbn-glow" as string]: a.glow }}
          data-kind={shown.kind}
          data-testid="naija-popup"
        >
          <span className="sbn-icon" aria-hidden="true">{a.icon}</span>
          <div className="sbn-body">
            <span className="sbn-label">{a.label}</span>
            <p className="sbn-text">{shown.message}</p>
          </div>
          <button type="button" className="sbn-close" onClick={close} aria-label="Close message">×</button>
          <span className="sbn-bar" style={{ animationDuration: `${NAIJA_POPUP_MS}ms` }} />
        </div>
      </div>
    </>
  );
}

const CSS = `
.sbn-wrap{position:fixed;z-index:2147483000;left:0;right:0;top:max(12px,env(safe-area-inset-top));display:flex;justify-content:center;padding:0 max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left));pointer-events:none}
.sbn-card{position:relative;overflow:hidden;display:flex;align-items:center;gap:12px;width:min(440px,100%);padding:14px 40px 16px 14px;border-radius:16px;color:#f1f5f9;
  background:linear-gradient(160deg,rgba(15,23,42,.97),rgba(2,6,12,.98));border:1px solid var(--sbn-ring);box-shadow:0 0 0 1px rgba(255,255,255,.04),0 16px 44px rgba(0,0,0,.6),0 0 28px var(--sbn-glow);
  pointer-events:auto;animation:sbn-in .38s cubic-bezier(.2,1.1,.3,1) both}
.sbn-card.sbn-leave{animation:sbn-out .3s ease-in both}
.sbn-icon{flex:none;display:grid;place-items:center;width:42px;height:42px;border-radius:12px;font-size:22px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.sbn-body{min-width:0}
.sbn-label{display:block;font:800 10.5px/1 system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--sbn-ring);margin-bottom:5px}
.sbn-text{margin:0;font:600 15px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
.sbn-close{position:absolute;top:6px;right:6px;width:32px;height:32px;border:0;border-radius:10px;background:transparent;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer;touch-action:manipulation}
.sbn-close:hover{background:rgba(255,255,255,.08);color:#fff}
.sbn-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--sbn-ring);transform-origin:left;animation:sbn-bar linear both}
@keyframes sbn-in{from{opacity:0;transform:translateY(-22px) scale(.96)}to{opacity:1;transform:none}}
@keyframes sbn-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-16px) scale(.97)}}
@keyframes sbn-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (min-width:768px){.sbn-wrap{top:max(18px,env(safe-area-inset-top))}.sbn-text{font-size:16px}}
@media (prefers-reduced-motion:reduce){.sbn-card,.sbn-card.sbn-leave{animation-duration:.01ms}.sbn-bar{animation:none;transform:scaleX(0)}}
`;
