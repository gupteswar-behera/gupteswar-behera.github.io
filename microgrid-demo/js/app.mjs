import { art, artAt } from "./art.mjs";
import { costTerms, deliveredCapacity, interp, mapPoints, noStorage, ruleBased, storedBand } from "./milp.mjs";

const $ = (s) => document.querySelector(s);
const TECHS = ["BESS", "PHES", "CAES", "FCES"]; // highest round trip first: the rule-based order
const INK = "var(--ink)";
const C = {
  grid: "var(--series-grid)", storage: "var(--series-storage)", solar: "var(--series-solar)",
  diesel: "var(--series-diesel)", opt: "var(--series-opt)", rule: "var(--series-rule)",
};
const TECH_COLOR = { BESS: C.storage, PHES: C.grid, CAES: C.diesel, FCES: C.solar };

const [windows, comp] = await Promise.all(["windows", "components"].map((n) => fetch(`data/${n}.json`).then((r) => r.json())));
const defaults = comp.defaults;
const SIZE_KEYS = TECHS.flatMap((k) => [`nameplate-${k}`, `power-${k}`]);
const initial = {
  win: "sunny", pv: defaults.pv_kw, grid: defaults.grid_kw, demand: 3000, diesel: defaults.diesel_kw,
  ...Object.fromEntries(SIZE_KEYS.map((key) => [key, key.startsWith("power") ? defaults.storage_kw : defaults.nameplate_kwh])),
};
const initialTechs = () => ["BESS"];
const RATINGS = ["pv", "grid", "demand", "diesel", ...SIZE_KEYS];
const allConnected = () => ({}); // state.off[key] is true for each disconnected component
const COST_DEFAULTS = {
  price_pct: 100, pv_cost: defaults.pv_cost, diesel_price: defaults.diesel_fuel_price,
  BESS: comp.storage.BESS.om_discharge, PHES: comp.storage.PHES.om_discharge, CAES: comp.storage.CAES.om_discharge,
  FCES_in: comp.storage.FCES.om_charge, FCES_out: comp.storage.FCES.om_discharge,
  spill_cost: defaults.spill_cost, voll: defaults.voll,
};
const COST_FIELDS = [
  { key: "price_pct", label: "Grid price", unit: "% of market", step: 5, kind: "grid" },
  { key: "pv_cost", label: "Solar energy", unit: "Rs/kWh", step: 0.05, kind: "solar" },
  { key: "diesel_price", label: "Diesel fuel", unit: "Rs/L", step: 1, kind: "diesel" },
  { key: "BESS", label: "BESS O&amp;M", unit: "Rs/kWh out", step: 0.05, kind: "BESS", tech: "BESS" },
  { key: "PHES", label: "PHES O&amp;M", unit: "Rs/kWh out", step: 0.05, kind: "PHES", tech: "PHES" },
  { key: "CAES", label: "CAES O&amp;M", unit: "Rs/kWh out", step: 0.05, kind: "CAES", tech: "CAES" },
  { key: "FCES_in", label: "Electrolyzer O&amp;M", unit: "Rs/kWh in", step: 0.05, kind: "FCES", tech: "FCES" },
  { key: "FCES_out", label: "Fuel cell O&amp;M", unit: "Rs/kWh out", step: 0.05, kind: "FCES", tech: "FCES" },
  { key: "spill_cost", label: "Spilled solar penalty", unit: "Rs/kWh", step: 0.05 },
  { key: "voll", label: "Unserved load penalty", unit: "Rs/kWh", step: 1 },
];
const basePrice = Object.fromEntries(Object.entries(windows).map(([k, w]) => [k, [...w.price]]));
const baseLoad = Object.fromEntries(Object.entries(windows).map(([k, w]) => [k, [...w.load_kw]]));
const highestLoad = Math.max(...Object.values(baseLoad).flat()); // one factor for both saved periods
// A system in the comparison section: which components it has, and its own ratings.
const SYSTEMS = ["A", "B"];
const newSystem = (tech) => {
  const { win, ...ratings } = initial;
  const { spill_cost, voll, ...prices } = COST_DEFAULTS; // the two penalties stay shared with the Build section
  return { ...ratings, ...prices, profile: "sunny", on: { solar: true, grid: true, diesel: true, load: true, [tech]: true } };
};
const newSystems = () => ({ A: newSystem("BESS"), B: newSystem("PHES") });
const energyPrice = (id, name) => ({ id, name, unit: "Rs/kWh", min: 0, max: 20, typed: 0.01, slid: 0.01 });
const SYSTEM_PARTS = [
  { key: "solar", label: "Solar array", ratings: [{ id: "pv", name: "Power", unit: "kW", min: 0, max: 10000, typed: 50, slid: 250 }, energyPrice("pv_cost", "Price")] },
  { key: "grid", label: "Grid connection", ratings: [{ id: "grid", name: "Power", unit: "kW", min: 0, max: 10000, typed: 50, slid: 100 }, { id: "price_pct", name: "Price", unit: "% market", min: 0, max: 300, typed: 5, slid: 5 }] },
  { key: "diesel", label: "Diesel generator", ratings: [{ id: "diesel", name: "Power", unit: "kW", min: 0, max: 10000, typed: 50, slid: 100 }, { id: "diesel_price", name: "Fuel", unit: "Rs/L", min: 0, max: 200, typed: 1, slid: 1 }] },
  ...TECHS.map((k) => ({
    key: k, label: k,
    ratings: [
      { id: `nameplate-${k}`, name: "Capacity", unit: "kWh", min: 5000, max: 40000, typed: 500, slid: 1000 },
      { id: `power-${k}`, name: "Power", unit: "kW", min: 1000, max: 20000, typed: 100, slid: 500 },
      ...(k === "FCES" ? [energyPrice("FCES_in", "Electrolyzer O&amp;M"), energyPrice("FCES_out", "Fuel cell O&amp;M")] : [energyPrice(k, "O&amp;M")]),
    ],
  })),
  { key: "load", label: "Load", ratings: [{ id: "demand", name: "Maximum", unit: "kW", min: 1500, max: 10000, typed: 50, slid: 100 }] },
];
const state = { ...initial, techs: initialTechs(), hour: 12, costs: { ...COST_DEFAULTS }, off: allConnected(), systems: newSystems() };

// Writes the edited rates into the saved data that every calculation reads.
function applyCosts() {
  const c = state.costs;
  comp.storage.BESS.om_discharge = c.BESS;
  comp.storage.PHES.om_discharge = c.PHES;
  comp.storage.CAES.om_discharge = c.CAES;
  comp.storage.FCES.om_charge = c.FCES_in;
  comp.storage.FCES.om_discharge = c.FCES_out;
  for (const k of Object.keys(windows)) {
    windows[k].price = basePrice[k].map((p) => (p * c.price_pct) / 100);
    windows[k].load_kw = baseLoad[k].map((x) => (x * state.demand) / highestLoad);
  }
}

function setRating(key, value) {
  const slider = $(`#${key}`);
  state[key] = Math.min(Number(slider.max), Math.max(Number(slider.min), value));
  recompute();
}
let results = { none: null, rule: null, opt: null, all: {} };
let token = 0;

const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
const num = (x, digits = 0) => (Number(x.toFixed(digits)) === 0 ? 0 : x).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); // solver dust must not print as -0
const rs = (x) => `${x < 0 ? "-" : ""}Rs ${num(Math.abs(x))}`;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const params = () => ({ ...defaults, pv_kw: state.pv, grid_kw: state.grid, diesel_kw: state.diesel, pv_cost: state.costs.pv_cost, spill_cost: state.costs.spill_cost, voll: state.costs.voll, diesel_fuel_price: state.costs.diesel_price });
// The operation section sees the microgrid with its disconnected elements taken out.
// The comparison of technologies always uses params() and the whole saved window.
const opParams = () => ({ ...params(), pv_kw: state.off.solar ? 0 : state.pv, grid_kw: state.off.grid ? 0 : state.grid, diesel_kw: state.off.diesel ? 0 : state.diesel });
const opWindow = () => (state.off.load ? { ...windows[state.win], load_kw: windows[state.win].load_kw.map(() => 0) } : windows[state.win]);
const unit = (k) => ({ ...comp.storage[k], key: k, nameplate_kwh: state[`nameplate-${k}`], storage_kw: state[`power-${k}`] });
const selected = () => TECHS.filter((k) => state.techs.includes(k));
const unitsIn = () => selected().filter((k) => !state.off[k]).map(unit);
// Everything a diagram, chart or table needs to know about one microgrid.
const operationSystem = () => ({ win: opWindow(), d: opParams(), techs: selected(), units: unitsIn(), off: state.off, pv: state.pv, diesel: state.diesel });
function comparedSystem(name) {
  const cfg = state.systems[name];
  const units = TECHS.filter((k) => cfg.on[k]).map((k) => ({
    ...comp.storage[k], key: k, nameplate_kwh: cfg[`nameplate-${k}`], storage_kw: cfg[`power-${k}`],
    om_charge: k === "FCES" ? cfg.FCES_in : comp.storage[k].om_charge,
    om_discharge: k === "FCES" ? cfg.FCES_out : cfg[k],
  }));
  const has = (key, rating) => (cfg.on[key] ? rating : 0);
  return {
    // Built from the unscaled saved data, because each system has its own price, maximum load
    // and solar profile. The shape of the load and of the price follow the saved days above.
    win: {
      ...windows[state.win],
      pv_per_kw: windows[cfg.profile].pv_per_kw,
      price: basePrice[state.win].map((p) => (p * cfg.price_pct) / 100),
      load_kw: baseLoad[state.win].map((x) => (cfg.on.load ? (x * cfg.demand) / highestLoad : 0)),
    },
    d: { ...params(), pv_kw: has("solar", cfg.pv), grid_kw: has("grid", cfg.grid), diesel_kw: has("diesel", cfg.diesel), pv_cost: cfg.pv_cost, diesel_fuel_price: cfg.diesel_price },
    techs: units.map((u) => u.key), units, pv: cfg.pv, diesel: cfg.diesel,
    off: { solar: !cfg.on.solar, grid: !cfg.on.grid, diesel: !cfg.on.diesel, load: !cfg.on.load },
    fixed: true, // no switches on its diagram, and components it does not have are left out
  };
}
const roundTrip = (t) => t.charge.eta.at(-1) * t.discharge.eta.at(-1);
const clockText = (t) => `Day ${t < 24 ? 1 : 2}, ${String(t % 24).padStart(2, "0")}:00`;

/* ---------- controls ---------- */

function buildControls() {
  $("#slots").innerHTML = TECHS
    .map((k) => `<label class="slot"><input type="checkbox" name="tech" value="${k}"><span class="face"><span class="head"><span class="abbr">${k}</span>${art(k, "art art-card")}</span><span class="full">${comp.storage[k].name}</span><span class="spec" data-spec="${k}"></span></span></label>`)
    .join("");
  const sizes = [
    { id: "nameplate", label: "nameplate capacity", unit: "kWh", min: 5000, max: 40000, typed: 500, slid: 1000 },
    { id: "power", label: "nameplate power", unit: "kW", min: 1000, max: 20000, typed: 100, slid: 500 },
  ];
  $("#storage-sizes").innerHTML = TECHS
    .flatMap((k) => sizes.map((s) => `<div class="rating" data-size-of="${k}">${art(k, "art art-card")}<div class="rating-body"><label for="${s.id}-${k}-num">${k} ${s.label}</label><div class="rating-value"><input id="${s.id}-${k}-num" type="number" min="${s.min}" max="${s.max}" step="${s.typed}" inputmode="numeric"><span>${s.unit}</span></div><input id="${s.id}-${k}" type="range" min="${s.min}" max="${s.max}" step="${s.slid}" aria-label="${k} ${s.label}"></div></div>`))
    .join("");
  document.querySelectorAll("[data-art]").forEach((el) => { el.innerHTML = art(el.dataset.art, "art art-card"); });
  $("#windows").innerHTML = Object.entries(windows)
    .map(([k, w]) => `<label><input type="radio" name="win" value="${k}"><span>${w.label}</span></label>`)
    .join("");
  document.querySelectorAll('input[name="tech"]').forEach((el) => el.addEventListener("change", () => {
    state.techs = [...document.querySelectorAll('input[name="tech"]:checked')].map((box) => box.value);
    recompute();
  }));
  document.querySelectorAll('input[name="win"]').forEach((el) => el.addEventListener("change", () => { state.win = el.value; recompute(); }));
  for (const key of RATINGS) {
    const slider = $(`#${key}`);
    const box = $(`#${key}-num`);
    slider.addEventListener("input", () => setRating(key, Number(slider.value)));
    box.addEventListener("input", () => {
      const value = Number(box.value);
      if (box.value === "" || !Number.isFinite(value) || value < Number(slider.min) || value > Number(slider.max)) return; // still typing
      setRating(key, value);
    });
    box.addEventListener("blur", () => { box.value = state[key]; });
  }
  $("#cost-fields").innerHTML = COST_FIELDS
    .map((f) => `<div class="cost-field"><label for="cost-${f.key}" class="with-art">${f.kind ? art(f.kind, "art art-small") : ""}<span>${f.label}</span></label><div class="cost-input"><input id="cost-${f.key}" type="number" min="0" step="${f.step}" inputmode="decimal"><span>${f.unit}</span></div></div>`)
    .join("");
  for (const f of COST_FIELDS) {
    $(`#cost-${f.key}`).addEventListener("input", (e) => {
      const value = Number(e.target.value);
      if (e.target.value === "" || !Number.isFinite(value) || value < 0) return; // keep the last valid rate
      state.costs[f.key] = value;
      recompute();
    });
    $(`#cost-${f.key}`).addEventListener("blur", (e) => { e.target.value = state.costs[f.key]; });
  }
  // The diagrams are redrawn every hour step, possibly between a press and its release, so a
  // switch is matched on the press and the release rather than on a click.
  const flip = (key) => { state.off[key] = !state.off[key]; recompute(); };
  let pressed = null;
  for (const host of [$("#diagram-rule"), $("#diagram-opt")]) {
    host.addEventListener("pointerdown", (e) => {
      const el = e.target.closest("[data-toggle]");
      pressed = el && e.button === 0 ? { key: el.dataset.toggle, x: e.clientX, y: e.clientY } : null;
    });
    host.addEventListener("keydown", (e) => {
      const el = e.target.closest("[data-toggle]");
      if (!el || (e.key !== " " && e.key !== "Enter")) return;
      e.preventDefault();
      flip(el.dataset.toggle);
    });
  }
  window.addEventListener("pointerup", (e) => {
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < 10) flip(pressed.key);
    pressed = null;
  });
  window.addEventListener("pointercancel", () => { pressed = null; });
  $("#reset").addEventListener("click", () => { Object.assign(state, initial, { techs: initialTechs(), costs: { ...COST_DEFAULTS }, off: allConnected() }); recompute(); });
  $("#hour").addEventListener("input", (e) => { state.hour = Number(e.target.value); stopPlay(); showHour(); });
  $("#play").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  $("#hourly").addEventListener("toggle", renderHourly);
}

function syncControls() {
  document.querySelectorAll('input[name="tech"]').forEach((el) => { el.checked = state.techs.includes(el.value); });
  document.querySelector(`input[name="win"][value="${state.win}"]`).checked = true;
  for (const key of RATINGS) {
    $(`#${key}`).value = state[key];
    const box = $(`#${key}-num`);
    if (document.activeElement !== box) box.value = state[key]; // never rewrite a box being typed in
  }
  $("#storage-sizes").hidden = !state.techs.length;
  document.querySelectorAll("[data-size-of]").forEach((el) => { el.hidden = !state.techs.includes(el.dataset.sizeOf); });
  for (const f of COST_FIELDS) {
    const el = $(`#cost-${f.key}`);
    if (document.activeElement !== el) el.value = state.costs[f.key]; // never rewrite a field being typed in
    el.closest(".cost-field").hidden = Boolean(f.tech) && !state.techs.includes(f.tech); // only the plugged-in storage
  }
  for (const k of TECHS) {
    const u = unit(k);
    document.querySelector(`[data-spec="${k}"]`).innerHTML = `Nameplate rating<br>${num(u.nameplate_kwh)} kWh, ${num(u.storage_kw)} kW`;
  }
}

/* ---------- solving ---------- */

let timer = null;
const comparing = () => !$("#choice").hidden; // all four are solved only when the comparison is on show
function recompute() {
  applyCosts();
  syncControls();
  const d = params();
  const win = windows[state.win];
  const od = opParams();
  const ow = opWindow();
  const units = unitsIn();
  results.baseNone = noStorage(win, d);
  results.all = {};
  for (const k of TECHS) results.all[k] = { rule: ruleBased(win, [unit(k)], d), opt: null };
  results.rule = ruleBased(ow, units, od);
  const hasChoice = units.length > 0 || od.diesel_kw > 0; // otherwise there is only one way to run
  results.opt = hasChoice ? null : results.rule;
  renderAll();
  recomputeSystems();
  token += 1; // a solve already running is out of date from this moment
  const current = token;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const jobs = hasChoice ? [{ name: "operation", units, win: ow, d: od }] : [];
    if (comparing()) jobs.push(...TECHS.map((name) => ({ name, units: [unit(name)] })));
    if (!jobs.length) {
      setStatus("Solved"); // nothing to schedule, so the results are already complete
      return;
    }
    setStatus("Solving...");
    worker.postMessage({ token: current, win, d, jobs });
  }, 180);
}

function renderOperation() {
  renderHeadline();
  renderPowerCharts();
  renderKpis();
  renderHourly();
}

worker.onmessage = ({ data }) => {
  if (data.token !== token) return;
  if (data.failed) {
    setStatus("The solver could not finish this case. Try different settings.");
    return;
  }
  if (data.name === "operation") {
    results.opt = data.result;
    renderOperation();
  } else {
    results.all[data.name].opt = data.result;
    renderCompare();
  }
  if (results.opt && (!comparing() || TECHS.every((k) => results.all[k].opt))) setStatus("Solved");
};
worker.onerror = () => setStatus("The solver could not be loaded in this browser.");

function setStatus(text) { $("#status").textContent = text; }

/* ---------- live diagram ---------- */

const BOX = { w: 200, h: 88 };
const HUB = { w: 136, h: 72 };

// Places n boxes evenly on a circle round the EMS, starting at the top and going clockwise, on
// the smallest circle where no box touches another or crowds the EMS.
function ringLayout(n) {
  const spot = (R, i) => {
    const a = ((-90 + (360 * i) / n) * Math.PI) / 180;
    return [R * Math.cos(a), R * Math.sin(a)];
  };
  for (let R = 150; ; R += 5) {
    const spots = Array.from({ length: n }, (_, i) => spot(R, i));
    const clearOfHub = spots.every(([x, y]) => Math.abs(x) >= (BOX.w + HUB.w) / 2 + 36 || Math.abs(y) >= (BOX.h + HUB.h) / 2 + 36);
    const clearOfEachOther = spots.every((p, i) => spots.slice(i + 1).every((q) => Math.abs(p[0] - q[0]) >= BOX.w + 14 || Math.abs(p[1] - q[1]) >= BOX.h + 26));
    if (clearOfHub && clearOfEachOther) return spots;
  }
}

// Every component of the microgrid at hour t. kw is the power it gives to the microgrid:
// positive supplies, negative takes. Solar is first, so it sits at the top of the circle, and
// the load last, on the upper left, where its shortfall note is clear of the lines.
function diagramNodes(sys, r, t) {
  const { win, d, off } = sys;
  const s = r?.series;
  const pv = win.pv_per_kw[t] * d.pv_kw;
  const load = win.load_kw[t];
  const g = s ? s.g[t] : 0;
  const dg = s ? s.dg[t] : 0;
  const short = s && s.us[t] > 1 ? s.us[t] : 0;
  const spilled = s && s.sp[t] > 1 ? s.sp[t] : 0;
  const pending = (text) => (s ? text : "...");
  const storage = sys.techs.map((k) => {
    if (off[k]) return { key: k, kind: k, title: k, value: "0 kW", sub: "Disconnected", kw: 0, color: C.storage, empty: true };
    const u = s?.units[k];
    const net = u ? u.pd[t] - u.pc[t] : 0;
    return {
      key: k, kind: k, title: k, value: pending(`${num(Math.abs(net))} kW`), kw: net, color: C.storage,
      sub: !s ? "Solving..." : net > 1 ? "Discharging" : net < -1 ? "Charging" : "Idle",
      level: u ? Math.max(0, Math.min(1, u.E[t] / storedBand(sys.units.find((x) => x.key === k)))) : null,
    };
  });
  const nodes = [
    { key: "solar", kind: "solar", title: "Solar array", value: `${num(pv)} kW`, kw: pv - spilled, color: C.solar, empty: off.solar || !sys.pv, sub: off.solar ? "Disconnected" : sys.pv ? (pv > 1 ? "Generating" : "No sun") : "Removed" },
    { key: "grid", kind: "grid", title: "Grid", value: pending(`${num(Math.abs(g))} kW`), kw: g, color: C.grid, empty: off.grid, sub: off.grid ? "Disconnected" : !s ? "" : g > 1 ? "Importing" : g < -1 ? "Exporting" : "Idle" },
    { key: "diesel", kind: "diesel", title: "Diesel", value: pending(`${num(dg)} kW`), kw: dg, color: C.diesel, empty: off.diesel || !sys.diesel, sub: off.diesel ? "Disconnected" : !sys.diesel ? "Removed" : !s ? "" : dg > 1 ? "Running" : "Standby" },
    ...storage,
    { key: "load", kind: "load", title: "Load", value: `${num(load)} kW`, kw: short - load, color: INK, empty: off.load, unserved: short > 0, sub: off.load ? "Disconnected" : "Demand" },
  ];
  return { nodes: sys.fixed ? nodes.filter((n) => !off[n.key]) : nodes, short, spilled, solved: Boolean(s) };
}

// The drawing area round n boxes. A system in the comparison can have no components at all,
// which leaves the EMS alone.
function ringFrame(n) {
  const spots = ringLayout(n);
  const pad = 14;
  return {
    halfW: Math.max(0, ...spots.map((p) => Math.abs(p[0]))) + BOX.w / 2 + pad,
    top: Math.min(0, ...spots.map((p) => p[1])) - BOX.h / 2 - pad,
    bottom: Math.max(0, ...spots.map((p) => p[1])) + BOX.h / 2 + pad + 10, // room for a note below the lowest box
  };
}

// Never narrower or shorter than the four-box circle, so a diagram with one to three boxes
// keeps the proportions of the others instead of being stretched tall to the panel width.
// `extra` widens the frame further, so two diagrams side by side can share one scale.
function diagramFrame(n, extra = []) {
  const frames = [ringFrame(4), ringFrame(n), ...extra.map(ringFrame)];
  return {
    halfW: Math.max(...frames.map((f) => f.halfW)),
    top: Math.min(...frames.map((f) => f.top)),
    bottom: Math.max(...frames.map((f) => f.bottom)),
  };
}

function diagramSVG(sys, r, t, alsoFit = []) {
  const { nodes, short, spilled, solved } = diagramNodes(sys, r, t);
  const spots = ringLayout(nodes.length);
  const { halfW, top, bottom } = diagramFrame(nodes.length, alsoFit);
  const thickness = (kw) => 2 + 6 * Math.min(1, Math.abs(kw) / 4000);
  const glow = (kw) => (kw > 1 ? " node-supply" : kw < -1 ? " node-take" : "");

  const wires = nodes.map((n, i) => `<line class="wire${sys.off[n.key] ? " wire-off" : ""}" data-node="${n.key}" x1="${spots[i][0]}" y1="${spots[i][1]}" x2="0" y2="0"/>`).join("");
  const flows = nodes.map((n, i) => {
    if (Math.abs(n.kw) < 1) return "";
    const [a, b] = n.kw > 0 ? [spots[i], [0, 0]] : [[0, 0], spots[i]];
    return `<line class="flow" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${n.color}" stroke-width="${thickness(n.kw)}"/>`;
  }).join("");

  const box = (n, [x, y]) => {
    const on = !sys.off[n.key];
    const tx = x + 62;
    const ty = y - 37;
    const toggle = sys.fixed ? "" : `<g class="node-toggle${on ? " on" : ""}" role="switch" tabindex="0" aria-checked="${on}" aria-label="${n.title} connected" data-toggle="${n.key}"><title>${on ? "Disconnect" : "Connect"} ${n.title}</title><rect x="${tx - 9}" y="${ty - 7}" width="52" height="32" fill="transparent"/><rect class="toggle-track" x="${tx}" y="${ty}" width="34" height="18" rx="9"/><circle class="toggle-knob" cx="${on ? tx + 25 : tx + 9}" cy="${ty + 9}" r="6.500"/></g>`;
    const bar = n.level === undefined || n.level === null ? "" : `<rect class="level-track" x="${x + 82}" y="${y - 12}" width="10" height="48" rx="3"/><rect class="level-fill" x="${x + 82}" y="${y + 36 - 48 * n.level}" width="10" height="${48 * n.level}" rx="3"/>`;
    return `<rect class="${n.empty ? "node-empty" : `node-box${n.unserved ? " node-unserved" : ""}${glow(n.kw)}`}" x="${x - BOX.w / 2}" y="${y - BOX.h / 2}" width="${BOX.w}" height="${BOX.h}" rx="12"/>
      ${artAt(n.kind, x - 95, y - 26, 52, n.empty ? 0.35 : 1)}
      <text class="node-title" x="${x - 39}" y="${y - 16}">${n.title}</text>
      <text class="node-value" x="${x - 39}" y="${y + 8}">${n.value}</text>
      <text class="node-sub" x="${x - 39}" y="${y + 28}">${n.sub}</text>
      ${bar}${toggle}`;
  };
  const boxes = nodes.map((n, i) => box(n, spots[i])).join("");

  // Each note sits beside its own box, on the outer side, clear of the line into the EMS.
  const loadAt = spots[nodes.length - 1] ?? [0, 0]; // no boxes at all when nothing is ticked
  const shortY = loadAt[1] > 1 ? loadAt[1] + BOX.h / 2 + 18 : loadAt[1] - BOX.h / 2 - 7;
  const notes = `${short ? `<text class="node-short" x="${loadAt[0] - BOX.w / 2}" y="${shortY}">${num(short)} kW not supplied</text>` : ""}${spilled && nodes[0].key === "solar" ? `<text class="node-sub" x="${spots[0][0] - 8}" y="${spots[0][1] + BOX.h / 2 + 17}" text-anchor="end">${num(spilled)} kW spilled</text>` : ""}`;

  const label = solved
    ? `${clockText(t)}. ${nodes.map((n) => `${n.title} ${n.value}, ${n.sub}`).join("; ")}${short ? `. ${num(short)} kW of load is not supplied` : ""}.`
    : `${clockText(t)}. Solving.`;
  return `<svg viewBox="${-halfW} ${top} ${2 * halfW} ${bottom - top}" role="group" aria-label="${label}">
    ${wires}${flows}
    <rect class="node-box" x="${-HUB.w / 2}" y="${-HUB.h / 2}" width="${HUB.w}" height="${HUB.h}" rx="12"/>
    <text class="hub-label" x="0" y="10" text-anchor="middle">EMS</text>
    ${boxes}${notes}
  </svg>`;
}

function renderDiagrams() {
  const sys = operationSystem();
  for (const [id, r] of [["#diagram-rule", results.rule], ["#diagram-opt", results.opt]]) {
    const host = $(id);
    const focused = host.contains(document.activeElement) ? document.activeElement.dataset.toggle : null;
    host.innerHTML = diagramSVG(sys, r, state.hour);
    // Redrawing would drop the keyboard focus. Without preventScroll the page jumps back to this
    // switch whenever an hour change redraws the diagrams, for example on hovering over a plot.
    if (focused) host.querySelector(`[data-toggle="${focused}"]`)?.focus({ preventScroll: true });
  }
  // Both compared systems are drawn in the same frame, so their boxes come out the same size.
  const compared = SYSTEMS.map((name) => [name, comparedSystem(name)]);
  const counts = compared.map(([name, sys]) => diagramNodes(sys, sysRuns[name].result, state.hour).nodes.length);
  for (const [name, sys] of compared) $(`#sys-diagram-${name}`).innerHTML = diagramSVG(sys, sysRuns[name].result, state.hour, counts);
}

function showHour() {
  $("#hour").value = state.hour;
  $("#sys-hour").value = state.hour;
  const win = windows[state.win];
  const clock = `${clockText(state.hour)}, Rs ${win.price[state.hour].toFixed(2)} per kWh`;
  $("#clock").textContent = clock;
  $("#sys-clock").textContent = clockText(state.hour); // each system has its own grid price
  renderDiagrams();
  cursors.forEach((c) => c(state.hour));
  systemCursors.forEach((c) => c(state.hour));
}

let playing = null;
const playLabels = (text) => { $("#play").textContent = text; $("#sys-play").textContent = text; };
function startPlay() {
  playLabels("Pause");
  playing = setInterval(() => { state.hour = (state.hour + 1) % 48; showHour(); }, 500);
}
function stopPlay() {
  clearInterval(playing);
  playing = null;
  playLabels("Play");
}

/* ---------- charts ---------- */

let cursors = [];
let systemCursors = [];

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return ticks;
}

function legend(host, items) {
  host.innerHTML = items
    .map((i) => `<span class="item"><span class="swatch${i.dash ? " dashed" : ""}" style="${i.dash ? `border-color:${i.color}` : `background:${i.color}`}"></span>${i.name}</span>`)
    .join("");
}

function placeTip(host, tip, px, py) {
  const box = host.getBoundingClientRect();
  tip.style.display = "block";
  const w = tip.offsetWidth;
  tip.style.left = `${px + 14 + w > box.width ? Math.max(0, px - w - 14) : px + 14}px`;
  tip.style.top = `${Math.max(0, py - 10)}px`;
}

// One axis, shared hour scale, synchronised crosshair.
function timeChart(host, cfg) {
  host.innerHTML = ""; // measure the free width, not the width of the previous drawing
  if (!host.clientWidth) return;
  const W = host.clientWidth;
  const H = cfg.height || 250;
  const direct = cfg.direct && W > 460;
  const m = { l: 62, r: direct ? 66 : 10, t: 8, b: 44 };
  const n = 48;
  const x = (i) => m.l + (i * (W - m.l - m.r)) / (n - 1);
  const y = (v) => m.t + ((cfg.domain[1] - v) * (H - m.t - m.b)) / (cfg.domain[1] - cfg.domain[0]);
  const ticks = niceTicks(cfg.domain[0], cfg.domain[1]);
  const gridlines = ticks
    .map((v) => `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 7}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`)
    .join("");
  const every = W < 420 ? 12 : 6;
  const xticks = [];
  for (let i = 0; i < n; i += every) xticks.push(`<text x="${x(i)}" y="${H - m.b + 18}" text-anchor="middle">${String(i % 24).padStart(2, "0")}</text>`);
  const axisTitles = `<text class="axis-title" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">Hour of the day</text><text class="axis-title" transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${cfg.yLabel}</text>`;
  const lines = cfg.series
    .filter((s) => s.values)
    .map((s) => `<path d="${s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/>`)
    .join("");
  let labels = "";
  if (direct) {
    const placed = cfg.series.filter((s) => s.values).map((s) => ({ name: s.name, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
    placed.forEach((p, i) => { if (i && p.y - placed[i - 1].y < 15) p.y = placed[i - 1].y + 15; });
    labels = placed.map((p) => `<text class="label" x="${W - m.r + 6}" y="${p.y + 4}">${p.name}</text>`).join("");
  }
  const day2 = `<line class="gridline" x1="${x(24)}" x2="${x(24)}" y1="${m.t}" y2="${H - m.b}"/>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${cfg.aria}">${gridlines}${day2}${xticks.join("")}${axisTitles}${lines}${labels}<line class="cursor" y1="${m.t}" y2="${H - m.b}"/><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg><div class="tip"></div>`;
  const cursor = host.querySelector(".cursor");
  const tip = host.querySelector(".tip");
  const setCursor = (i) => { cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); };
  setCursor(state.hour);
  (cfg.cursors ?? cursors).push(setCursor);
  const rect = host.querySelector("rect");
  const move = (e) => {
    const b = host.getBoundingClientRect();
    const px = e.clientX - b.left;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) * (n - 1)) / (W - m.l - m.r))));
    if (i !== state.hour) { state.hour = i; stopPlay(); showHour(); }
    tip.innerHTML = `<b>${clockText(i)}</b>${cfg.series.filter((s) => s.values).map((s) => `<div class="row"><span class="key"><span class="swatch" style="background:${s.color}"></span>${s.name}</span><span>${num(s.values[i], cfg.digits || 0)}${cfg.unit || ""}</span></div>`).join("")}`;
    placeTip(host, tip, px, e.clientY - b.top);
  };
  rect.addEventListener("pointermove", move);
  rect.addEventListener("pointerdown", move);
  rect.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}

function powerSeries(sys, r) {
  const { win, d, off } = sys;
  const solar = win.pv_per_kw.map((x) => x * d.pv_kw);
  return [
    { name: "Load", color: INK, values: off.load ? null : win.load_kw },
    { name: "Grid", color: C.grid, values: r && !off.grid ? r.series.g : null },
    { name: "Storage", color: C.storage, values: r && sys.units.length ? r.series.pd.map((v, i) => v - r.series.pc[i]) : null },
    { name: "Solar", color: C.solar, values: off.solar ? null : solar },
    { name: "Diesel", color: C.diesel, values: r && d.diesel_kw > 0 ? r.series.dg : null },
  ];
}

function powerKeys(sys) {
  return [
    !sys.off.load && { name: "Load", color: INK },
    !sys.off.grid && { name: "Grid (above zero is import)", color: C.grid },
    sys.units.length && { name: "Storage (above zero is discharge)", color: C.storage },
    !sys.off.solar && { name: "Solar", color: C.solar },
    sys.d.diesel_kw > 0 && { name: "Diesel", color: C.diesel },
  ].filter(Boolean);
}

function powerDomain(seriesLists) {
  const all = seriesLists.flat().filter((s) => s.values).flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all); // every element can be disconnected at once
  const step = 1000;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

function renderPowerCharts() {
  cursors = [];
  const sys = operationSystem();
  const seriesRule = powerSeries(sys, results.rule);
  const seriesOpt = powerSeries(sys, results.opt);
  const domain = powerDomain([seriesRule, seriesOpt]);
  legend($("#legend-rule"), powerKeys(sys));
  legend($("#legend-opt"), powerKeys(sys));
  timeChart($("#chart-rule"), { series: seriesRule, domain, direct: true, unit: " kW", yLabel: "Power (kW)", height: 280, aria: "Power by source under rule-based operation over 48 hours" });
  timeChart($("#chart-opt"), { series: seriesOpt, domain, direct: true, unit: " kW", yLabel: "Power (kW)", height: 280, aria: "Power by source under optimised operation over 48 hours" });
  const win = windows[state.win];
  timeChart($("#chart-price"), { series: [{ name: "Grid price", color: INK, values: win.price }], domain: [0, Math.ceil(Math.max(...win.price))], height: 230, digits: 2, yLabel: "Price (Rs per kWh)", aria: "Grid price over 48 hours" });
  // The model's level counts from the bottom of the usable band, so add what sits below it.
  const pct = (r, u) => (r ? r.series.units[u.key].E.map((e) => 100 * (u.floor_fraction + e / u.nameplate_kwh)) : null);
  const levels = unitsIn().flatMap((u) => [
    { name: `${u.key}, rule-based`, color: TECH_COLOR[u.key], dash: true, values: pct(results.rule, u) },
    { name: `${u.key}, optimised`, color: TECH_COLOR[u.key], values: pct(results.opt, u) },
  ]);
  legend($("#level-legend"), levels);
  timeChart($("#chart-level"), {
    series: levels,
    domain: [0, 100], height: 230, unit: "%", digits: 1, yLabel: "SOC (% of nameplate)", aria: "State of charge as a percentage of nameplate capacity over 48 hours",
  });
  showHour();
}

function renderEfficiency() {
  const CHG = "var(--series-opt)";
  const DIS = "var(--series-storage)";
  legend($("#eff-legend"), [
    { name: "Charging, piecewise-linear", color: CHG },
    { name: "Discharging, piecewise-linear", color: DIS },
    { name: "Published curve", color: "var(--muted)", dash: true },
  ]);
  const grid = $("#eff-grid");
  grid.innerHTML = TECHS.map((k) => `<div class="card"><h4 class="with-art">${art(k, "art art-small")}${k}</h4><div class="chart" data-eff="${k}"></div><p class="eff-note" data-eff-note="${k}"></p></div>`).join("");
  for (const k of TECHS) {
    const t = comp.storage[k];
    const host = grid.querySelector(`[data-eff="${k}"]`);
    const W = host.clientWidth || 240;
    const H = 214;
    const m = { l: 36, r: 16, t: 8, b: 44 };
    const x = (f) => m.l + f * (W - m.l - m.r);
    const y = (e) => m.t + ((1 - e) * (H - m.t - m.b)) / 0.7;
    const implied = (curve, dir) => {
      const map = mapPoints(curve, dir);
      return (f) => (dir === "charge" ? interp(curve.f, map, f) / f : f / interp(curve.f, map, f));
    };
    const breakpoints = (curve) => (k === "BESS" || k === "PHES" ? [0.25, 0.5, 0.75, 1] : curve.f);
    const draw = (curve, dir, color) => {
      const fn = implied(curve, dir);
      const a = Math.max(curve.f[0], 0.02);
      const pts = [];
      for (let f = a; f <= 1.0001; f += 0.01) pts.push(`${pts.length ? "L" : "M"}${x(f).toFixed(1)} ${y(fn(Math.min(f, 1))).toFixed(1)}`);
      const dots = breakpoints(curve).map((f) => `<circle cx="${x(f)}" cy="${y(fn(f))}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`).join("");
      return `<path d="${pts.join("")}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
    };
    const dashed = (c) => (c ? `<path d="${c.f.map((f, i) => `${i ? "L" : "M"}${x(f).toFixed(1)} ${y(c.eta[i]).toFixed(1)}`).join("")}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>` : "");
    const yt = [0.4, 0.6, 0.8, 1].map((v) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 5}" y="${y(v) + 4}" text-anchor="end">${v * 100}</text>`).join("");
    const xt = [0.25, 0.5, 0.75, 1].map((f) => `<text x="${x(f)}" y="${H - 26}" text-anchor="middle">${f * 100}</text>`).join("");
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${k} efficiency against load"><line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>${yt}${xt}<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">Load (%)</text>${dashed(t.true_charge)}${dashed(t.true_discharge)}${draw(t.charge, "charge", CHG)}${draw(t.discharge, "discharge", DIS)}<line class="cursor" y1="${m.t}" y2="${H - m.b}" style="display:none"/><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg><div class="tip"></div>`;
    const fnC = implied(t.charge, "charge");
    const fnD = implied(t.discharge, "discharge");
    const tip = host.querySelector(".tip");
    const cursor = host.querySelector(".cursor");
    const rect = host.querySelector("rect");
    const move = (e) => {
      const b = host.getBoundingClientRect();
      const px = e.clientX - b.left;
      const f = Math.max(0.01, Math.min(1, Math.round((100 * (px - m.l)) / (W - m.l - m.r)) / 100));
      cursor.style.display = "";
      cursor.setAttribute("x1", x(f));
      cursor.setAttribute("x2", x(f));
      const val = (fn, curve) => (f >= curve.f[0] ? `${(fn(f) * 100).toFixed(1)}%` : "Off");
      tip.innerHTML = `<b>${Math.round(f * 100)}% load</b><div class="row"><span class="key">Charging</span><span>${val(fnC, t.charge)}</span></div><div class="row"><span class="key">Discharging</span><span>${val(fnD, t.discharge)}</span></div>`;
      placeTip(host, tip, px, e.clientY - b.top);
    };
    rect.addEventListener("pointermove", move);
    rect.addEventListener("pointerdown", move);
    rect.addEventListener("pointerleave", () => { tip.style.display = "none"; cursor.style.display = "none"; });

    const maxError = (curve, truth, dir) => {
      const fn = implied(curve, dir);
      let worst = 0;
      truth.f.forEach((f, i) => { if (f >= curve.f[0]) worst = Math.max(worst, Math.abs(fn(f) - truth.eta[i])); });
      return worst * 100;
    };
    const note = t.constant_efficiency
      ? `Constant efficiency, ${Math.round(t.charge.eta[0] * 100)}% each way.`
      : `Largest model error ${Math.max(maxError(t.charge, t.true_charge, "charge"), maxError(t.discharge, t.true_discharge, "discharge")).toFixed(1)} points.`;
    grid.querySelector(`[data-eff-note="${k}"]`).textContent = note;
  }
}

function renderBars() {
  const host = $("#chart-bars");
  host.innerHTML = "";
  if (!host.clientWidth) return;
  const none = results.baseNone.cost;
  const rows = TECHS.map((k) => {
    const a = results.all[k];
    return { k, rule: (100 * (none - a.rule.cost)) / none, opt: a.opt ? (100 * (none - a.opt.cost)) / none : null };
  });
  const values = rows.flatMap((r) => [r.rule, r.opt ?? 0, 0]);
  const lo = Math.floor(Math.min(...values) / 10) * 10;
  const hi = Math.ceil(Math.max(...values, 10) / 10) * 10;
  const W = host.clientWidth;
  const rowH = 54;
  const m = { l: 56, r: 56, t: 6, b: 24 };
  const H = m.t + m.b + rowH * rows.length;
  const x = (v) => m.l + ((v - lo) * (W - m.l - m.r)) / (hi - lo);
  const ticks = niceTicks(lo, hi, W < 420 ? 4 : 6);
  const barH = 14;
  const bar = (v, yy, color) => {
    const [a, b] = [Math.min(x(0), x(v)), Math.max(x(0), x(v))];
    return `<rect x="${a}" y="${yy}" width="${Math.max(1, b - a)}" height="${barH}" rx="3" fill="${color}"/><text class="label" x="${v >= 0 ? b + 5 : a - 5}" y="${yy + 11}" text-anchor="${v >= 0 ? "start" : "end"}">${v.toFixed(1)}%</text>`;
  };
  const body = rows.map((r, i) => {
    const y0 = m.t + rowH * i;
    return `<text class="label" x="0" y="${y0 + 27}">${r.k}</text>${bar(r.rule, y0 + 8, C.rule)}${r.opt === null ? `<text x="${x(0) + 5}" y="${y0 + 36}">Solving...</text>` : bar(r.opt, y0 + 26, C.opt)}<rect class="hit" data-i="${i}" x="0" y="${y0}" width="${W}" height="${rowH}" fill="transparent"/>`;
  }).join("");
  const grid = ticks.map((v) => `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${x(v)}" y="${H - 6}" text-anchor="middle">${v}%</text>`).join("");
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Saving compared with no storage for each technology, rule-based and optimised">${grid}${body}</svg><div class="tip"></div>`;
  const tip = host.querySelector(".tip");
  host.querySelectorAll(".hit").forEach((el) => {
    const r = rows[Number(el.dataset.i)];
    const show = (e) => {
      const b = host.getBoundingClientRect();
      tip.innerHTML = `<b>${r.k}</b><div class="row"><span class="key">Rule-based</span><span>${r.rule.toFixed(1)}%</span></div><div class="row"><span class="key">Optimised</span><span>${r.opt === null ? "Solving" : `${r.opt.toFixed(1)}%`}</span></div>`;
      placeTip(host, tip, e.clientX - b.left, e.clientY - b.top);
    };
    el.addEventListener("pointermove", show);
    el.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  });
}

/* ---------- text and tables ---------- */

function renderHeadline() {
  const h = $("#headline");
  const tile = (name, r) => `<div class="tile"><span class="name">${name}</span><span class="value">${r ? rs(r.cost) : "..."}</span></div>`;
  $("#tiles").innerHTML = tile("Rule-based, running cost", results.rule) + tile("Optimised, running cost", results.opt);
  if (!results.opt) {
    h.innerHTML = "<span>Solving the optimised case...</span>";
    return;
  }
  const units = unitsIn();
  const save = results.rule.cost - results.opt.cost;
  if (!units.length && Math.abs(save) < 1) {
    const chosen = selected();
    h.innerHTML = chosen.length
      ? `<span>${chosen.join(" + ")} ${chosen.length > 1 ? "are" : "is"} disconnected, so rule-based and optimised operation are the same.</span>`
      : "<span>Plug in a storage technology to compare rule-based and optimised operation.</span>";
    return;
  }
  const names = units.map((u) => u.key).join(" + ") || "this microgrid";
  if (Math.abs(save) < 1) {
    h.innerHTML = `<strong>Rs 0</strong><span>saved by optimising ${names} in this configuration: rule-based operation already reaches the lowest cost</span>`;
    return;
  }
  const share = results.rule.cost > 1 ? ` (${((100 * save) / results.rule.cost).toFixed(1)}% of the rule-based cost)` : "";
  const shed = sum(results.rule.series.us) + sum(results.opt.series.us) > 1 ? ". These costs include the unserved load penalty" : "";
  h.innerHTML = `<strong>${rs(save)}</strong><span>saved by optimising ${names} instead of following rules, over these two days${share}${shed}</span>`;
}

function metrics(r, units) {
  if (!r) return null;
  const s = r.series;
  const nameplate = sum(units.map((u) => u.nameplate_kwh));
  return {
    imported: sum(s.g.map((g) => Math.max(g, 0))) / 1000,
    exported: sum(s.g.map((g) => Math.max(-g, 0))) / 1000,
    discharged: sum(s.pd) / 1000,
    cycles: nameplate ? sum(s.pd) / nameplate : 0,
    diesel: sum(s.dg) / 1000,
    spill: sum(s.sp) / 1000,
  };
}

function renderKpis() {
  const units = unitsIn();
  energyTable($("#kpis"), [["Rule-based", metrics(results.rule, units)], ["Optimised", metrics(results.opt, units)]]);
  renderCosts();
}

function energyTable(host, cols) {
  const row = (label, fn) => `<tr><td>${label}</td>${cols.map(([, m]) => `<td>${m ? fn(m) : "..."}</td>`).join("")}</tr>`;
  host.innerHTML = `<thead><tr><th>Measure</th>${cols.map(([n]) => `<th>${n}</th>`).join("")}</tr></thead><tbody>
    ${row("Grid import (MWh)", (m) => num(m.imported, 1))}
    ${row("Grid export (MWh)", (m) => num(m.exported, 1))}
    ${row("Energy discharged from storage (MWh)", (m) => num(m.discharged, 1))}
    ${row("Equivalent full cycles, on nameplate", (m) => num(m.cycles, 2))}
    ${row("Diesel generation (MWh)", (m) => num(m.diesel, 1))}
    ${row("Solar spilled (MWh)", (m) => num(m.spill, 1))}
  </tbody>`;
}

function costColumns() {
  const win = opWindow();
  const d = opParams();
  const units = unitsIn();
  const of = (r) => (r ? costTerms(win, units, d, r) : null);
  return [
    ["Rule-based", of(results.rule)],
    ["Optimised", of(results.opt)],
  ];
}

const COST_PARTS = [
  { key: "gridImport", name: "Grid import cost", color: "var(--series-grid)" },
  { key: "solar", name: "Solar energy cost", color: "var(--series-solar)" },
  { key: "storage", name: "Storage operation and maintenance", color: "var(--series-storage)" },
  { key: "diesel", name: "Diesel fuel cost", color: "var(--series-diesel)" },
  { key: "gridExport", name: "Grid export income", color: "var(--series-export)" },
  { key: "spill", name: "Spilled solar penalty", color: "var(--series-penalty)" },
  { key: "unserved", name: "Unserved load penalty", color: "var(--series-penalty)" },
];

function costTable(host, cols) {
  const money = (v) => (Math.abs(v) < 0.5 ? "Rs 0" : rs(v));
  const row = (label, fn, cls = "") => `<tr class="${cls}"><td>${label}</td>${cols.map(([, c]) => `<td>${c ? fn(c) : "..."}</td>`).join("")}</tr>`;
  host.innerHTML = `<thead><tr><th>Cost term</th>${cols.map(([n]) => `<th>${n}</th>`).join("")}</tr></thead><tbody>
    ${COST_PARTS.map((p) => row(p.name, (c) => money(c[p.key]))).join("")}
    ${row("Total running cost", (c) => rs(c.total), "selected")}
    ${row("Cost of energy (Rs per kWh of load)", (c) => (c.coe === null ? "n/a" : c.coe.toFixed(2)), "selected")}
  </tbody>`;
}

function renderCosts() {
  const cols = costColumns();
  costTable($("#costs"), cols);
  renderCostChart(cols);
}

function renderCostChart(cols = costColumns(), host = $("#chart-costs"), key = $("#costs-legend")) {
  host.innerHTML = "";
  if (!host.clientWidth) return;
  const ready = cols.filter(([, c]) => c).map(([, c]) => c);
  const stack = (c, sign) => COST_PARTS.reduce((s, p) => s + (sign * c[p.key] > 0 ? c[p.key] : 0), 0);
  const lakh = 100000;
  const lo = Math.floor(Math.min(0, ...ready.map((c) => stack(c, -1))) / lakh);
  const hi = Math.max(lo + 1, Math.ceil(Math.max(...ready.map((c) => stack(c, 1))) / lakh)); // every cost can be zero
  const used = COST_PARTS.filter((p) => ready.some((c) => Math.abs(c[p.key]) >= 0.5));
  const shown = used.filter((p, i) => used.findIndex((q) => q.color === p.color) === i || p.color !== "var(--series-penalty)");
  legend(key, shown.map((p) => ({ name: p.color === "var(--series-penalty)" ? "Penalties" : p.name, color: p.color })));
  const W = host.clientWidth;
  const rowH = 58;
  const m = { l: W < 480 ? 74 : 92, r: W < 480 ? 10 : 18, t: 22, b: 26 };
  const H = m.t + m.b + rowH * cols.length;
  const x = (v) => m.l + ((v / lakh - lo) * (W - m.l - m.r)) / (hi - lo);
  const barH = 26;
  const ticks = niceTicks(lo, hi, W < 480 ? 4 : 7);
  const grid = ticks.map((v) => `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${x(v * lakh)}" x2="${x(v * lakh)}" y1="${m.t - 4}" y2="${H - m.b}"/><text x="${x(v * lakh)}" y="${H - 7}" text-anchor="middle">${num(v, Number.isInteger(v) ? 0 : 1)}</text>`).join("");
  const rows = cols.map(([name, c], i) => {
    const y0 = m.t + rowH * i;
    const yBar = y0 + (rowH - barH) / 2;
    const label = `<text class="label" x="0" y="${yBar + 18}">${name}</text>`;
    if (!c) return `${label}<text x="${x(0) + 6}" y="${yBar + 18}">Solving...</text>`;
    const segments = (sign) => {
      let at = 0;
      return COST_PARTS.filter((p) => sign * c[p.key] >= 0.5).map((p) => {
        const a = x(at);
        at += c[p.key];
        const b = x(at);
        const left = Math.min(a, b);
        return `<rect x="${left + 1}" y="${yBar}" width="${Math.max(1.5, Math.abs(b - a) - 2)}" height="${barH}" rx="3" fill="${p.color}"/>`;
      }).join("");
    };
    const end = x(stack(c, 1));
    const total = `<text class="label" text-anchor="end" x="${Math.min(end, W - m.r)}" y="${yBar - 4}">Total ${rs(c.total)}</text>`;
    return `${label}${segments(1)}${segments(-1)}${total}<rect class="hit" data-i="${i}" x="0" y="${y0}" width="${W}" height="${rowH}" fill="transparent"/>`;
  }).join("");
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Cost terms for ${cols.map(([name]) => name).join(" and ")}">${grid}<text x="${W - m.r}" y="11" text-anchor="end">Rs lakh</text>${rows}</svg><div class="tip"></div>`;
  const tip = host.querySelector(".tip");
  host.querySelectorAll(".hit").forEach((el) => {
    const [name, c] = cols[Number(el.dataset.i)];
    const show = (e) => {
      const b = host.getBoundingClientRect();
      const lines = COST_PARTS.filter((p) => Math.abs(c[p.key]) >= 0.5).map((p) => `<div class="row"><span class="key"><span class="swatch" style="background:${p.color}"></span>${p.name}</span><span>${rs(c[p.key])}</span></div>`).join("");
      tip.innerHTML = `<b>${name}</b>${lines}<div class="row"><span class="key">Total</span><span>${rs(c.total)}</span></div>`;
      placeTip(host, tip, e.clientX - b.left, e.clientY - b.top);
    };
    el.addEventListener("pointermove", show);
    el.addEventListener("pointerdown", show);
    el.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  });
}

function renderCompare() {
  renderBars();
  const d = params();
  const head = ["Storage", "Usable capacity (kWh)", "Round trip at full load", "Operation and maintenance (Rs per kWh out)", "Rule-based cost", "Optimised cost", "Optimised cost of energy (Rs per kWh)"];
  const win = windows[state.win];
  const body = TECHS.map((k) => {
    const t = comp.storage[k];
    const a = results.all[k];
    const om = k === "FCES" ? `${t.om_charge} in, ${t.om_discharge} out` : `${t.om_discharge}`;
    return `<tr class="${state.techs.includes(k) ? "selected" : ""}"><td><span class="with-art">${art(k, "art art-small")}${k}</span></td><td>${num(deliveredCapacity(unit(k)))}</td><td>${Math.round(roundTrip(t) * 100)}%</td><td>${om}</td><td>${rs(a.rule.cost)}</td><td>${a.opt ? rs(a.opt.cost) : "Solving..."}</td><td>${a.opt ? costTerms(win, [unit(k)], d, a.opt).coe.toFixed(2) : "..."}</td></tr>`;
  }).join("");
  $("#compare").innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody>`;
}

function renderHourly() {
  if (!$("#hourly").open) return;
  const win = opWindow();
  const d = opParams();
  const net = (r, t) => (r ? num(r.series.pd[t] - r.series.pc[t]) : "...");
  const grid = (r, t) => (r ? num(r.series.g[t]) : "...");
  const diesel = (r, t) => (r ? num(r.series.dg[t]) : "...");
  const rows = win.load_kw.map((L, t) => `<tr><td>${clockText(t)}</td><td>${win.price[t].toFixed(2)}</td><td>${num(L)}</td><td>${num(win.pv_per_kw[t] * d.pv_kw)}</td><td>${grid(results.rule, t)}</td><td>${net(results.rule, t)}</td><td>${diesel(results.rule, t)}</td><td>${grid(results.opt, t)}</td><td>${net(results.opt, t)}</td><td>${diesel(results.opt, t)}</td></tr>`).join("");
  $("#hourly-table").innerHTML = `<thead><tr><th>Hour</th><th>Price (Rs/kWh)</th><th>Load (kW)</th><th>Solar (kW)</th><th>Rule-based grid (kW)</th><th>Rule-based storage (kW)</th><th>Rule-based diesel (kW)</th><th>Optimised grid (kW)</th><th>Optimised storage (kW)</th><th>Optimised diesel (kW)</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ---------- two systems side by side ---------- */

// Each system has its own solver, so editing one never waits for, or restarts, the other.
const sysRuns = Object.fromEntries(SYSTEMS.map((name) => [name, { worker: new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" }), token: 0, key: null, result: null, failed: false, timer: null }]));

function buildSystems() {
  for (const name of SYSTEMS) {
    $(`#sys-config-${name}`).innerHTML = `<h4>System ${name}</h4>${SYSTEM_PARTS.map((part) => `
      <div class="sys-part">
        <label class="sys-head"><input type="checkbox" id="sys-${name}-on-${part.key}">${art(part.key, "art art-small")}<span>${part.label}</span></label>
        <div class="sys-ratings" id="sys-${name}-ratings-${part.key}">${part.ratings.map((r) => `
          <div class="sys-rating">
            <label for="sys-${name}-${r.id}-num">${r.name}</label>
            <input id="sys-${name}-${r.id}" type="range" min="${r.min}" max="${r.max}" step="${r.slid}" aria-label="System ${name} ${part.label} ${r.name}">
            <input id="sys-${name}-${r.id}-num" type="number" min="${r.min}" max="${r.max}" step="${r.typed}" inputmode="numeric">
            <span>${r.unit}</span>
          </div>`).join("")}${part.key === "solar" ? `
          <div class="sys-rating">
            <label for="sys-${name}-profile">Profile</label>
            <select id="sys-${name}-profile">${Object.entries(windows).map(([k, w]) => `<option value="${k}">${w.label}</option>`).join("")}</select>
          </div>` : ""}</div>
      </div>`).join("")}`;
    $(`#sys-${name}-profile`).addEventListener("change", (e) => {
      state.systems[name].profile = e.target.value;
      syncSystems();
      recomputeSystems();
    });
    for (const part of SYSTEM_PARTS) {
      $(`#sys-${name}-on-${part.key}`).addEventListener("change", (e) => {
        state.systems[name].on[part.key] = e.target.checked;
        syncSystems();
        recomputeSystems();
      });
      for (const r of part.ratings) {
        const slider = $(`#sys-${name}-${r.id}`);
        const box = $(`#sys-${name}-${r.id}-num`);
        const set = (value) => {
          state.systems[name][r.id] = Math.min(r.max, Math.max(r.min, value));
          syncSystems();
          recomputeSystems();
        };
        slider.addEventListener("input", () => set(Number(slider.value)));
        box.addEventListener("input", () => {
          const value = Number(box.value);
          if (box.value === "" || !Number.isFinite(value) || value < r.min || value > r.max) return; // still typing
          set(value);
        });
        box.addEventListener("blur", () => { box.value = state.systems[name][r.id]; });
      }
    }
  }
  $("#sys-reset").addEventListener("click", () => { state.systems = newSystems(); syncSystems(); recomputeSystems(); });
  $("#sys-hour").addEventListener("input", (e) => { state.hour = Number(e.target.value); stopPlay(); showHour(); });
  $("#sys-play").addEventListener("click", () => (playing ? stopPlay() : startPlay()));
  for (const name of SYSTEMS) {
    const run = sysRuns[name];
    run.worker.onmessage = ({ data }) => {
      if (data.token !== run.token) return;
      run.failed = Boolean(data.failed);
      if (!data.failed) run.result = data.result;
      renderSystems();
    };
    run.worker.onerror = () => { run.failed = true; renderSystems(); };
  }
}

function syncSystems() {
  for (const name of SYSTEMS) {
    const cfg = state.systems[name];
    $(`#sys-${name}-profile`).value = cfg.profile;
    for (const part of SYSTEM_PARTS) {
      $(`#sys-${name}-on-${part.key}`).checked = Boolean(cfg.on[part.key]);
      $(`#sys-${name}-ratings-${part.key}`).hidden = !cfg.on[part.key];
      for (const r of part.ratings) {
        $(`#sys-${name}-${r.id}`).value = cfg[r.id];
        const box = $(`#sys-${name}-${r.id}-num`);
        if (document.activeElement !== box) box.value = cfg[r.id]; // never rewrite a box being typed in
      }
    }
  }
}

// Solves only the systems whose inputs changed. The load, saved days and rates come from above.
function recomputeSystems() {
  let changed = false;
  for (const name of SYSTEMS) {
    const sys = comparedSystem(name);
    const run = sysRuns[name];
    const cfg = state.systems[name];
    const key = JSON.stringify([state.win, cfg.profile, cfg.demand, cfg.price_pct, sys.off.load, sys.d, sys.units.map((u) => [u.key, u.nameplate_kwh, u.storage_kw, u.om_charge, u.om_discharge])]);
    if (key === run.key) continue;
    changed = true;
    run.key = key;
    run.token += 1;
    run.failed = false;
    clearTimeout(run.timer);
    if (sys.units.length || sys.d.diesel_kw > 0) {
      run.result = null;
      const current = run.token;
      run.timer = setTimeout(() => run.worker.postMessage({ token: current, win: sys.win, d: sys.d, jobs: [{ name, units: sys.units }] }), 180);
    } else {
      run.result = ruleBased(sys.win, [], sys.d); // with nothing to schedule there is only one way to run
    }
  }
  if (changed) renderSystems();
}

function renderSystems() {
  systemCursors = [];
  const models = Object.fromEntries(SYSTEMS.map((name) => [name, comparedSystem(name)]));
  const result = (name) => sysRuns[name].result;
  const lists = SYSTEMS.map((name) => powerSeries(models[name], result(name)));
  const domain = powerDomain(lists);
  SYSTEMS.forEach((name, i) => {
    const sys = models[name];
    legend($(`#sys-legend-${name}`), powerKeys(sys));
    timeChart($(`#sys-chart-${name}`), { series: lists[i], domain, direct: true, unit: " kW", yLabel: "Power (kW)", height: 280, cursors: systemCursors, aria: `Power by source in system ${name} over 48 hours` });
    const r = result(name);
    const levels = sys.units.map((u) => ({ name: u.key, color: TECH_COLOR[u.key], values: r ? r.series.units[u.key].E.map((e) => 100 * (u.floor_fraction + e / u.nameplate_kwh)) : null }));
    legend($(`#sys-level-legend-${name}`), levels);
    timeChart($(`#sys-level-${name}`), { series: levels, domain: [0, 100], height: 230, unit: "%", digits: 1, yLabel: "SOC (% of nameplate)", cursors: systemCursors, aria: `State of charge in system ${name} over 48 hours` });
  });
  const energy = SYSTEMS.map((name) => [`System ${name}`, metrics(result(name), models[name].units)]);
  const costs = SYSTEMS.map((name) => [`System ${name}`, result(name) ? costTerms(models[name].win, models[name].units, models[name].d, result(name)) : null]);
  energyTable($("#sys-energy"), energy);
  costTable($("#sys-costs"), costs);
  renderCostChart(costs, $("#sys-chart-costs"), $("#sys-costs-legend"));
  renderSystemHeadline();
  renderSystemStatus();
  showHour();
}

function renderSystemHeadline() {
  const [a, b] = SYSTEMS.map((name) => sysRuns[name].result);
  const tile = (name, r) => `<div class="tile"><span class="name">System ${name}, running cost</span><span class="value">${r ? rs(r.cost) : "..."}</span></div>`;
  $("#sys-tiles").innerHTML = tile("A", a) + tile("B", b);
  const h = $("#sys-headline");
  if (!a || !b) {
    h.innerHTML = "<span>Solving...</span>";
    return;
  }
  const gap = Math.abs(a.cost - b.cost);
  if (gap < 1) {
    h.innerHTML = "<span>The two systems cost the same to run over these two days.</span>";
    return;
  }
  const [cheaper, dearer, dearerCost] = a.cost < b.cost ? ["A", "B", b.cost] : ["B", "A", a.cost];
  const share = Math.min(a.cost, b.cost) > 1 ? ` (${((100 * gap) / dearerCost).toFixed(1)}%)` : ""; // a percentage means nothing if one system earns money
  const shed = sum(a.series.us) + sum(b.series.us) > 1 ? ". These costs include the unserved load penalty" : "";
  h.innerHTML = `<strong>${rs(gap)}</strong><span>less to run with System ${cheaper} than with System ${dearer}, over these two days${share}${shed}</span>`;
}

function renderSystemStatus() {
  const runs = SYSTEMS.map((name) => sysRuns[name]);
  $("#sys-status").textContent = runs.some((run) => run.failed) ? "The solver could not finish this case. Try different settings." : runs.some((run) => !run.result) ? "Solving..." : "Solved";
}

function renderAll() {
  renderHeadline();
  renderPowerCharts();
  renderKpis();
  renderCompare();
  renderHourly();
}

/* ---------- start ---------- */

buildControls();
buildSystems();
syncSystems();
legend($("#price-legend"), [{ name: "Grid price", color: INK }]);
legend($("#bars-legend"), [{ name: "Rule-based", color: C.rule }, { name: "Optimised", color: C.opt }]);
recompute();
renderEfficiency();

// Follows the laid-out width of the content, which settles after the window's resize event.
let resizeTimer = null;
let drawnWidth = $("main").clientWidth;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = $("main").clientWidth;
    if (width === drawnWidth) return;
    drawnWidth = width;
    renderPowerCharts();
    renderBars();
    renderCostChart();
    renderEfficiency();
    renderSystems();
  }, 120);
}).observe($("main"));
