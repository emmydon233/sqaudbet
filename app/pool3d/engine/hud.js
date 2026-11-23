/**
 * DOM heads-up display for the Pool gameplay screen (vanilla DOM so the 60 fps game loop never
 * triggers React re-renders). All class names are `pq-*` and are styled only in pool-game.css
 * under `.pool-game-shell.pg-root`, so nothing here can affect any other SquadBet page.
 */
import { BALL_COLORS, cssColor, groupLabel } from "./common";
const ICONS = {
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.2-3.5a6.6 6.6 0 0 0-.1-1.2l2-1.5-2-3.5-2.4.9a7.7 7.7 0 0 0-2-1.2L15.3 3h-4l-.4 2.5a7.7 7.7 0 0 0-2 1.2l-2.4-.9-2 3.5 2 1.5a6.6 6.6 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-.9c.6.5 1.3.9 2 1.2l.4 2.5h4l.4-2.5c.7-.3 1.4-.7 2-1.2l2.4.9 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor"/><path class="pq-wave" d="M15 9a4.5 4.5 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path class="pq-mute" d="M15 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.6v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    exit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const LABELS = { settings: "Settings", sound: "Sound", fullscreen: "Full screen", help: "Help and rules", exit: "Exit match" };
function initials(name) {
    const clean = name.replace(/^@/, "").trim();
    return (clean.slice(0, 2) || "?").toUpperCase();
}
function hueFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i += 1)
        h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}
function ballChip(id) {
    const color = cssColor(BALL_COLORS[id]);
    const bg = id >= 9 ? `linear-gradient(180deg,#f4ecd6 0 26%,${color} 26% 74%,#f4ecd6 74%)` : color;
    const fg = id === 8 || id === 2 || id === 4 || id === 7 ? "#fff" : "#111";
    return `<i class="pq-chip" data-id="${id}" style="background:${bg};color:${id >= 9 ? "#111" : fg}">${id}</i>`;
}
export class PoolHud {
    constructor(host, cb) {
        this.cb = cb;
        this.q = (sel) => this.root.querySelector(sel);
        this.cleanup = [];
        this.powerActive = false;
        this.spinX = 0;
        this.spinY = 0;
        this.lastSpinTap = 0;
        this.lastTrayKey = ["", ""];
        this.root = document.createElement("div");
        this.root.className = "pq-hud";
        this.root.innerHTML = `
      <div class="pq-vignette"></div>
      <header class="pq-top">
        ${[0, 1]
            .map((i) => `
        <section class="pq-player pq-p${i}" data-player="${i}">
          <div class="pq-avatar"><span class="pq-initials">${i + 1}</span><img alt="" hidden /></div>
          <div class="pq-pinfo">
            <div class="pq-namerow"><span class="pq-name">Player ${i + 1}</span><span class="pq-you" hidden>YOU</span></div>
            <div class="pq-sub"><span class="pq-group">Open table</span><span class="pq-stats"></span></div>
            <div class="pq-tray" aria-label="Remaining balls"></div>
          </div>
          <div class="pq-turn" aria-live="polite">WAITING</div>
        </section>`)
            .join("")}
        <section class="pq-center">
          <div class="pq-brand">SQUAD<b>BET</b> · 8-BALL</div>
          <div class="pq-stake" hidden></div>
          <div class="pq-status" aria-live="polite"></div>
          <div class="pq-countdown" hidden></div>
        </section>
      </header>
      <aside class="pq-power" aria-label="Shot power">
        <span class="pq-power-label">POWER</span>
        <div class="pq-power-track" role="slider" aria-label="Shot power" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
          <div class="pq-power-fill"></div>
          <div class="pq-power-ticks"></div>
          <div class="pq-power-thumb"><span></span></div>
        </div>
        <span class="pq-power-value">0%</span>
      </aside>
      <div class="pq-spin" aria-label="Cue-ball spin">
        <div class="pq-spin-ball" role="slider" aria-label="Spin position" tabindex="-1">
          <span class="pq-spin-h"></span><span class="pq-spin-v"></span>
          <span class="pq-spin-dot"></span>
        </div>
        <span class="pq-spin-label">SPIN</span>
      </div>
      <nav class="pq-buttons" aria-label="Game controls"></nav>
      <div class="pq-fine" aria-label="Fine aim">
        <button type="button" class="pq-fine-btn" data-dir="-1" aria-label="Rotate aim counter-clockwise"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.2-5.1M5 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span class="pq-fine-label">FINE</span>
        <button type="button" class="pq-fine-btn" data-dir="1" aria-label="Rotate aim clockwise"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.2-5.1M19 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="pq-hint" hidden></div>
      <div class="pq-banner" aria-live="assertive"></div>
    `;
        host.appendChild(this.root);
        const nav = this.q(".pq-buttons");
        ["settings", "sound", "fullscreen", "help", "exit"].forEach((name) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `pq-btn pq-btn-${name}`;
            btn.setAttribute("aria-label", LABELS[name]);
            btn.title = LABELS[name];
            btn.innerHTML = ICONS[name];
            this.on(btn, "click", () => {
                this.cb.gesture();
                this.cb.button(name);
            });
            nav.appendChild(btn);
        });
        const fsOk = typeof document !== "undefined" && (document.fullscreenEnabled || "webkitFullscreenEnabled" in document);
        if (!fsOk)
            nav.querySelector(".pq-btn-fullscreen").hidden = true;
        this.wirePower();
        this.wireSpin();
        this.wireFine();
        this.on(this.root, "pointerdown", () => this.cb.gesture(), true);
    }
    on(el, type, fn, capture = false) {
        el.addEventListener(type, fn, capture);
        this.cleanup.push(() => el.removeEventListener(type, fn, capture));
    }
    /* ---------- power meter: drag the thumb down to pull the cue back, release to shoot ---------- */
    wirePower() {
        const track = this.q(".pq-power-track");
        const aside = this.q(".pq-power");
        let startY = 0;
        let pointerId = -1;
        let value = 0;
        const height = () => Math.max(1, track.getBoundingClientRect().height);
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        this.on(aside, "pointerdown", (e) => {
            if (pointerId !== -1 || aside.classList.contains("is-disabled"))
                return;
            pointerId = e.pointerId;
            aside.setPointerCapture(e.pointerId);
            startY = e.clientY;
            value = 0; // always starts from zero: grabbing the bar and letting go cannot fire a shot
            this.powerActive = true;
            aside.classList.add("is-dragging");
            this.cb.power(0, "start");
            e.preventDefault();
        });
        this.on(aside, "pointermove", (e) => {
            if (e.pointerId !== pointerId)
                return;
            value = clamp01((e.clientY - startY) / height());
            this.cb.power(value, "move");
        });
        const finish = (e, cancelled) => {
            if (e.pointerId !== pointerId)
                return;
            pointerId = -1;
            this.powerActive = false;
            aside.classList.remove("is-dragging");
            try {
                aside.releasePointerCapture(e.pointerId);
            }
            catch { /* already released */ }
            const final = value;
            value = 0;
            this.cb.power(final, cancelled ? "cancel" : "end");
        };
        this.on(aside, "pointerup", (e) => finish(e, false));
        this.on(aside, "pointercancel", (e) => finish(e, true));
        this.on(aside, "lostpointercapture", (e) => { if (pointerId === e.pointerId)
            finish(e, true); });
    }
    get isPowerDragging() {
        return this.powerActive;
    }
    /* ---------- spin selector: a miniature cue ball, the dot is where the tip strikes ---------- */
    wireSpin() {
        const ball = this.q(".pq-spin-ball");
        let id = -1;
        const set = (e) => {
            const r = ball.getBoundingClientRect();
            let x = ((e.clientX - r.left) / r.width) * 2 - 1;
            let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
            const len = Math.hypot(x, y);
            const max = 0.86;
            if (len > max) {
                x = (x / len) * max;
                y = (y / len) * max;
            }
            this.setSpin(x, y);
            this.cb.spin(this.spinX, this.spinY);
        };
        this.on(ball, "pointerdown", (e) => {
            id = e.pointerId;
            ball.setPointerCapture(id);
            const now = performance.now();
            if (now - this.lastSpinTap < 320) {
                this.setSpin(0, 0);
                this.cb.spin(0, 0);
            }
            else
                set(e);
            this.lastSpinTap = now;
            e.preventDefault();
        });
        this.on(ball, "pointermove", (e) => { if (e.pointerId === id && (e.buttons || e.pointerType === "touch"))
            set(e); });
        const end = (e) => { if (e.pointerId === id)
            id = -1; };
        this.on(ball, "pointerup", end);
        this.on(ball, "pointercancel", end);
    }
    wireFine() {
        this.root.querySelectorAll(".pq-fine-btn").forEach((btn) => {
            const dir = Number(btn.dataset.dir);
            this.on(btn, "pointerdown", (e) => { btn.setPointerCapture(e.pointerId); this.cb.fine(dir); e.preventDefault(); });
            const stop = () => this.cb.fine(0);
            this.on(btn, "pointerup", stop);
            this.on(btn, "pointercancel", stop);
            this.on(btn, "lostpointercapture", stop);
        });
    }
    /* ---------- public updates ---------- */
    setPlayers(players, localIndex) {
        players.forEach((p, i) => {
            const card = this.q(`.pq-p${i}`);
            const name = p.username.startsWith("@") ? p.username : `@${p.username}`;
            card.querySelector(".pq-name").textContent = name;
            card.querySelector(".pq-you").hidden = i !== localIndex;
            const avatar = card.querySelector(".pq-avatar");
            avatar.style.setProperty("--pq-hue", String(hueFor(p.username)));
            card.querySelector(".pq-initials").textContent = initials(p.username);
            const img = card.querySelector("img");
            if (p.avatarUrl) {
                img.hidden = true;
                img.onload = () => { img.hidden = false; };
                img.onerror = () => { img.hidden = true; };
                img.src = p.avatarUrl;
            }
            else
                img.hidden = true;
            const stats = card.querySelector(".pq-stats");
            stats.textContent = p.stats ? `${p.stats.won}W · ${p.stats.played} played` : "";
        });
    }
    setStake(amount) {
        const el = this.q(".pq-stake");
        el.hidden = amount === null;
        if (amount !== null)
            el.textContent = `Stake ₦${amount.toLocaleString("en-NG")}`;
    }
    /** `turn` = whose turn it is; `live` = match running; `over` = finished. */
    setTurn(turn, localIndex, live, over) {
        for (const i of [0, 1]) {
            const card = this.q(`.pq-p${i}`);
            const active = live && !over && turn === i;
            card.classList.toggle("is-active", active);
            const badge = card.querySelector(".pq-turn");
            badge.textContent = over ? "MATCH OVER" : !live ? "LOBBY" : active ? (i === localIndex ? "YOUR TURN" : "SHOOTING") : "WAITING";
        }
        this.root.classList.toggle("is-my-turn", live && !over && turn === localIndex);
    }
    setGroups(groups) {
        for (const i of [0, 1]) {
            const el = this.q(`.pq-p${i} .pq-group`);
            el.textContent = groupLabel(groups[i] ?? null);
            el.dataset.group = groups[i] ?? "open";
        }
    }
    /** Remaining-ball trays. Shows each player's group, or "Table open" until groups are assigned. */
    setTrays(groups, pocketed) {
        for (const i of [0, 1]) {
            const group = groups[i] ?? null;
            const ids = group === "solid" ? [1, 2, 3, 4, 5, 6, 7] : group === "stripe" ? [9, 10, 11, 12, 13, 14, 15] : [];
            const cleared = group !== null && ids.every((id) => pocketed.has(id));
            const key = `${group}|${ids.map((id) => (pocketed.has(id) ? 1 : 0)).join("")}|${cleared ? (pocketed.has(8) ? 2 : 1) : 0}`;
            if (key === this.lastTrayKey[i])
                continue;
            this.lastTrayKey[i] = key;
            const tray = this.q(`.pq-p${i} .pq-tray`);
            if (!group) {
                tray.innerHTML = '<span class="pq-open">Table open</span>';
                continue;
            }
            const remaining = ids.filter((id) => !pocketed.has(id)).length;
            tray.innerHTML =
                ids.map((id) => ballChip(id).replace("pq-chip", pocketed.has(id) ? "pq-chip is-out" : "pq-chip")).join("") +
                    (cleared ? ballChip(8).replace("pq-chip", `pq-chip pq-eight${pocketed.has(8) ? " is-out" : " is-live"}`) : "") +
                    `<span class="pq-left">${cleared ? "Pocket the 8" : `${remaining} left`}</span>`;
        }
    }
    setStatus(text) {
        const el = this.q(".pq-status");
        if (el.textContent !== text)
            el.textContent = text;
    }
    setCountdown(seconds) {
        const el = this.q(".pq-countdown");
        el.hidden = seconds <= 0;
        if (seconds > 0)
            el.textContent = `Reconnect window ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    setHint(text) {
        const el = this.q(".pq-hint");
        el.hidden = !text;
        if (text)
            el.textContent = text;
    }
    showBanner(text, tone = "info", ms = 1500) {
        const el = this.q(".pq-banner");
        el.textContent = text;
        el.dataset.tone = tone;
        el.classList.remove("show");
        void el.offsetWidth; // restart the CSS animation
        el.classList.add("show");
        window.clearTimeout(this.bannerTimer);
        this.bannerTimer = window.setTimeout(() => el.classList.remove("show"), ms);
    }
    /** 0..1 */
    setPower(value) {
        const v = Math.min(1, Math.max(0, value));
        const pct = Math.round(v * 100);
        const track = this.q(".pq-power-track");
        track.style.setProperty("--pq-power", String(v));
        track.setAttribute("aria-valuenow", String(pct));
        this.q(".pq-power-value").textContent = `${pct}%`;
    }
    setInteractive(canShoot) {
        this.q(".pq-power").classList.toggle("is-disabled", !canShoot);
        this.root.classList.toggle("can-shoot", canShoot);
        this.root.querySelectorAll(".pq-fine-btn").forEach((b) => { b.disabled = !canShoot; });
        this.q(".pq-spin").classList.toggle("is-disabled", !canShoot);
    }
    setSpin(x, y) {
        this.spinX = x;
        this.spinY = y;
        const dot = this.q(".pq-spin-dot");
        dot.style.left = `${50 + x * 50}%`;
        dot.style.top = `${50 - y * 50}%`;
        this.q(".pq-spin").classList.toggle("has-spin", Math.hypot(x, y) > 0.04);
    }
    setSoundOn(on) {
        this.q(".pq-btn-sound").classList.toggle("is-off", !on);
    }
    setFullscreenOn(on) {
        this.q(".pq-btn-fullscreen").classList.toggle("is-on", on);
    }
    /** Screen-space area the 3D table may occupy so it never hides behind HUD elements. */
    getInsets() {
        const rootRect = this.root.getBoundingClientRect();
        const top = this.q(".pq-top").getBoundingClientRect();
        const power = this.q(".pq-power").getBoundingClientRect();
        const buttons = this.q(".pq-buttons").getBoundingClientRect();
        return {
            top: Math.max(0, top.bottom - rootRect.top - 2),
            left: Math.max(0, power.right - rootRect.left + 6),
            right: Math.max(0, rootRect.right - buttons.left + 6),
            bottom: 8,
        };
    }
    dispose() {
        window.clearTimeout(this.bannerTimer);
        this.cleanup.forEach((fn) => fn());
        this.cleanup = [];
        this.root.remove();
    }
}
