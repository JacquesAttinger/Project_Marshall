// Last edited: 2026-10-03 18:27 CDT
// The dashboard's only script. Every 5 s it fetches /sections and swaps the sections whose hash
// changed, keeping what the person was doing: open hand-offs stay open (and are not fetched
// again), the scroll position holds, and an armed Kill button stays armed across the swap.
// Polling pauses while the tab is hidden. No inline script or style: the CSP forbids both.

const POLL_MS = 5000;
const ARM_MS = 4000;
const MESSAGE_MS = 15000;

/** Identifier → timeout id, for Kill buttons tapped once. Lives here, not in the DOM. */
const armed = new Map();
/** Identifier → { text, ok, until }, so a kill result survives the next swap. */
const messages = new Map();
/** Identifier → hand-off HTML already fetched. */
const handoffs = new Map();
/** Identifiers whose hand-off is open. */
const open = new Set();

let lastOk = Date.now();
let lost = false;
let timer = null;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function renderUpdated() {
  const el = $("#updated");
  if (!el) return;
  const s = Math.max(0, Math.round((Date.now() - lastOk) / 1000));
  const ago = s < 5 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  el.textContent = lost ? `Connection lost · updated ${ago}` : `Updated ${ago}`;
  el.classList.toggle("lost", lost);
}

function applyKillState(root) {
  for (const button of root.querySelectorAll("button[data-kill]")) {
    const id = button.dataset.kill;
    const isArmed = armed.has(id);
    button.classList.toggle("armed", isArmed);
    button.textContent = isArmed ? `Tap again to kill ${id}` : "Kill";
  }
  for (const span of root.querySelectorAll("[data-kill-msg]")) {
    const msg = messages.get(span.dataset.killMsg);
    if (msg && msg.until > Date.now()) {
      span.textContent = msg.text;
      span.classList.toggle("bad", !msg.ok);
    }
  }
}

function applyHandoffState(root) {
  for (const details of root.querySelectorAll("details[data-handoff]")) {
    const id = details.dataset.handoff;
    if (handoffs.has(id)) {
      const body = $("[data-handoff-body]", details);
      if (body) body.innerHTML = handoffs.get(id);
    }
    if (open.has(id)) details.open = true;
  }
}

function swap(name, html, hash) {
  const el = document.getElementById(`s-${name}`);
  if (!el || el.dataset.hash === hash) return;
  el.innerHTML = html;
  el.dataset.hash = hash;
  applyHandoffState(el);
  applyKillState(el);
}

async function refresh() {
  try {
    const res = await fetch("/sections", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const { scrollX, scrollY } = window;
    for (const name of Object.keys(body.sections)) {
      swap(name, body.sections[name], body.hashes[name]);
    }
    window.scrollTo(scrollX, scrollY);
    lastOk = Date.now();
    lost = false;
  } catch {
    lost = true;
  }
  renderUpdated();
}

function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, POLL_MS);
}

async function loadHandoff(details) {
  const id = details.dataset.handoff;
  if (handoffs.has(id)) return;
  const body = $("[data-handoff-body]", details);
  try {
    const res = await fetch(`/handoff/${encodeURIComponent(id)}`, { cache: "no-store" });
    const html = res.ok ? await res.text() : '<p class="muted">No hand-off file found.</p>';
    if (res.ok) handoffs.set(id, html);
    if (body) body.innerHTML = html;
  } catch {
    if (body) body.textContent = "Could not load the hand-off.";
  }
}

function disarm(id) {
  clearTimeout(armed.get(id));
  armed.delete(id);
  applyKillState(document);
}

async function kill(id) {
  disarm(id);
  messages.set(id, { text: "Killing…", ok: true, until: Date.now() + MESSAGE_MS });
  applyKillState(document);
  let result;
  try {
    const res = await fetch(`/kill/${encodeURIComponent(id)}`, { method: "POST" });
    result = await res.json();
  } catch {
    result = { ok: false, message: "Could not reach the dashboard." };
  }
  messages.set(id, { text: result.message, ok: result.ok, until: Date.now() + MESSAGE_MS });
  applyKillState(document);
  refresh();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-kill]");
  if (!button) return;
  const id = button.dataset.kill;
  if (armed.has(id)) {
    kill(id);
    return;
  }
  armed.set(
    id,
    setTimeout(() => disarm(id), ARM_MS),
  );
  applyKillState(document);
});

// `toggle` does not bubble, so listen in the capture phase.
document.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.handoff) return;
    if (details.open) {
      open.add(details.dataset.handoff);
      loadHandoff(details);
    } else {
      open.delete(details.dataset.handoff);
    }
  },
  true,
);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
    return;
  }
  refresh().then(schedule);
});

setInterval(renderUpdated, 1000);
schedule();
