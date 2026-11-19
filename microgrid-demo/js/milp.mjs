// Simplified piecewise-linear MILP and rule-based operation over a saved window, for any number
// of storage units and an optional diesel generator. tools/reference_model.py checks the MILP
// against Gurobi. A unit is a storage technology with its own nameplate_kwh and storage_kw.

export function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
  }
  return ys[ys.length - 1];
}

// Power map per unit of rating: charge gives energy stored, discharge gives energy drawn.
export function mapPoints(curve, direction) {
  return curve.f.map((f, k) => (direction === "charge" ? f * curve.eta[k] : f / curve.eta[k]));
}

export function storedBand(unit) {
  return unit.nameplate_kwh * unit.band_fraction;
}

export function deliveredCapacity(unit) {
  const eta = unit.discharge.eta;
  return storedBand(unit) * eta[eta.length - 1];
}

// Fuel cost in one hour: litres are a slope on output plus a no-load burn while running,
// from the rule-based notebook. The no-load burn scales with the rating.
export function dieselFuelCost(kw, running, d) {
  return d.diesel_fuel_price * (d.diesel_fuel_slope * kw + d.diesel_fuel_idle * d.diesel_kw * running);
}

function term(coef, name) {
  const c = Number(coef.toPrecision(12));
  return `${c >= 0 ? "+" : "-"} ${Math.abs(c)} ${name}`;
}

function wrap(terms) {
  const lines = [];
  for (let i = 0; i < terms.length; i += 6) lines.push(terms.slice(i, i + 6).join(" "));
  return lines.join("\n ");
}

// A concave charge map or a convex discharge map needs no breakpoint adjacency binaries.
function needsAdjacency(f, y, direction) {
  const slopes = [];
  for (let k = 1; k < f.length; k++) slopes.push((y[k] - y[k - 1]) / (f[k] - f[k - 1]));
  for (let k = 1; k < slopes.length; k++) {
    const change = slopes[k] - slopes[k - 1];
    if (direction === "charge" ? change > 1e-9 : change < -1e-9) return true;
  }
  return false;
}

export function buildLP(win, units, d) {
  const T = win.load_kw.length;
  const pv = win.pv_per_kw.map((x) => x * d.pv_kw);
  const hasDiesel = d.diesel_kw > 0;
  const dieselMin = hasDiesel ? d.diesel_min_fraction * d.diesel_kw : 0;
  // When surplus power cannot all be exported, wasting energy avoids the spill penalty, and
  // without adjacency the solver would waste it inside the map instead of following the curve.
  const saturated = pv.some((x, t) => x + dieselMin - win.load_kw[t] > d.grid_kw + 1e-6);

  const plans = units.map((u, i) => {
    const fc = u.charge.f;
    const fd = u.discharge.f;
    const yc = mapPoints(u.charge, "charge");
    const yd = mapPoints(u.discharge, "discharge");
    const band = storedBand(u);
    return {
      u, fc, fd, yc, yd, band, P: u.storage_kw, start: band * u.start_fraction, id: `u${i}`,
      adjC: fc.length > 2 && (saturated || needsAdjacency(fc, yc, "charge")),
      adjD: fd.length > 2 && (saturated || needsAdjacency(fd, yd, "discharge")),
    };
  });

  const obj = [];
  const cons = [];
  const bounds = [];
  const binaries = [];

  const addAdjacency = (lam, seg, on, n, t) => {
    const s = [];
    for (let k = 0; k < n - 1; k++) {
      s.push(`+ 1 ${seg}${k}_${t}`);
      binaries.push(`${seg}${k}_${t}`);
    }
    cons.push(`${seg}sum_${t}: ${s.join(" ")} - 1 ${on}_${t} = 0`);
    for (let k = 0; k < n; k++) {
      const parts = [`+ 1 ${lam}${k}_${t}`];
      if (k > 0) parts.push(`- 1 ${seg}${k - 1}_${t}`);
      if (k < n - 1) parts.push(`- 1 ${seg}${k}_${t}`);
      cons.push(`${seg}adj${k}_${t}: ${parts.join(" ")} <= 0`);
    }
  };

  for (let t = 0; t < T; t++) {
    obj.push(term(win.price[t], `g_${t}`), term(d.voll, `us_${t}`), term(d.spill_cost, `sp_${t}`));
    const balance = [`+ 1 g_${t}`, `- 1 sp_${t}`, `+ 1 us_${t}`];

    if (hasDiesel) {
      obj.push(term(dieselFuelCost(1, 0, d), `dg_${t}`), term(dieselFuelCost(0, 1, d), `du_${t}`));
      balance.push(`+ 1 dg_${t}`);
      cons.push(`dgmax_${t}: + 1 dg_${t} ${term(-d.diesel_kw, `du_${t}`)} <= 0`);
      cons.push(`dgmin_${t}: + 1 dg_${t} ${term(-dieselMin, `du_${t}`)} >= 0`);
      binaries.push(`du_${t}`);
    }

    for (const { u, fc, fd, yc, yd, band, P, start, id, adjC, adjD } of plans) {
      fc.forEach((f, k) => {
        if (u.om_charge) obj.push(term(u.om_charge * P * f, `${id}lc${k}_${t}`));
        balance.push(term(-P * f, `${id}lc${k}_${t}`));
      });
      fd.forEach((f, k) => {
        if (u.om_discharge) obj.push(term(u.om_discharge * P * f, `${id}ld${k}_${t}`));
        balance.push(term(P * f, `${id}ld${k}_${t}`));
      });

      const level = [`+ 1 ${id}E_${t}`];
      yc.forEach((y, k) => level.push(term(-P * y, `${id}lc${k}_${t}`)));
      yd.forEach((y, k) => level.push(term(P * y, `${id}ld${k}_${t}`)));
      if (t > 0) level.push(`- 1 ${id}E_${t - 1}`);
      cons.push(`${id}lev_${t}: ${wrap(level)} = ${t === 0 ? start : 0}`);

      cons.push(`${id}cc_${t}: ${fc.map((_, k) => `+ 1 ${id}lc${k}_${t}`).join(" ")} - 1 ${id}uc_${t} = 0`);
      cons.push(`${id}cd_${t}: ${fd.map((_, k) => `+ 1 ${id}ld${k}_${t}`).join(" ")} - 1 ${id}ud_${t} = 0`);
      cons.push(`${id}mode_${t}: + 1 ${id}uc_${t} + 1 ${id}ud_${t} <= 1`);
      if (adjC) addAdjacency(`${id}lc`, `${id}sc`, `${id}uc`, fc.length, t);
      if (adjD) addAdjacency(`${id}ld`, `${id}sd`, `${id}ud`, fd.length, t);

      bounds.push(`0 <= ${id}E_${t} <= ${band}`);
      binaries.push(`${id}uc_${t}`, `${id}ud_${t}`);
    }

    cons.push(`bal_${t}: ${wrap(balance)} = ${win.load_kw[t] - pv[t]}`);
    bounds.push(`${-d.grid_kw} <= g_${t} <= ${d.grid_kw}`);
    bounds.push(`0 <= us_${t} <= ${win.load_kw[t]}`); // or a low penalty would let it create energy to sell
  }

  const lp = [
    "Minimize",
    ` obj: ${wrap(obj)}`,
    "Subject To",
    ...cons.map((c) => ` ${c}`),
    "Bounds",
    ...bounds.map((b) => ` ${b}`),
    "Binary",
    ...binaries.map((b) => ` ${b}`),
    "End",
    "",
  ].join("\n");

  const constant = pv.reduce((sum, x) => sum + d.pv_cost * x, 0);
  return { lp, constant };
}

const emptySeries = (units) => ({
  g: [], sp: [], us: [], dg: [], du: [], pc: [], pd: [],
  units: Object.fromEntries(units.map((u) => [u.key, { E: [], pc: [], pd: [] }])),
});

export function solveWindow(highs, win, units, d) {
  const { lp, constant } = buildLP(win, units, d);
  const sol = highs.solve(lp, { mip_rel_gap: 1e-4, time_limit: 20, presolve: "on" });
  const T = win.load_kw.length;
  const col = (name) => (sol.Columns[name] ? sol.Columns[name].Primal : 0);
  const out = emptySeries(units);
  for (let t = 0; t < T; t++) {
    out.g.push(col(`g_${t}`));
    out.sp.push(col(`sp_${t}`));
    out.us.push(col(`us_${t}`));
    out.dg.push(col(`dg_${t}`));
    out.du.push(col(`du_${t}`) > 0.5 ? 1 : 0);
    let charged = 0;
    let discharged = 0;
    units.forEach((u, i) => {
      const P = u.storage_kw;
      const pc = u.charge.f.reduce((s, f, k) => s + P * f * col(`u${i}lc${k}_${t}`), 0);
      const pd = u.discharge.f.reduce((s, f, k) => s + P * f * col(`u${i}ld${k}_${t}`), 0);
      out.units[u.key].E.push(col(`u${i}E_${t}`));
      out.units[u.key].pc.push(pc);
      out.units[u.key].pd.push(pd);
      charged += pc;
      discharged += pd;
    });
    out.pc.push(charged);
    out.pd.push(discharged);
  }
  return { status: sol.Status, cost: sol.ObjectiveValue + constant, series: out };
}

function invert(f, y, value) {
  if (value < y[0]) return 0;
  for (let k = 1; k < f.length; k++) {
    if (value <= y[k]) return f[k - 1] + ((f[k] - f[k - 1]) * (value - y[k - 1])) / (y[k] - y[k - 1]);
  }
  return f[f.length - 1];
}

// Solar to load, then storage, then grid, then diesel. Surplus solar charges storage, then
// exports. Storage units are used in the order given, for charging and discharging alike.
export function ruleBased(win, units, d) {
  const T = win.load_kw.length;
  const plans = units.map((u) => ({
    u, P: u.storage_kw, band: storedBand(u), fc: u.charge.f, fd: u.discharge.f,
    yc: mapPoints(u.charge, "charge"), yd: mapPoints(u.discharge, "discharge"),
    E: storedBand(u) * u.start_fraction,
  }));
  const dieselMin = d.diesel_min_fraction * d.diesel_kw;
  const out = emptySeries(units);
  let cost = 0;
  for (let t = 0; t < T; t++) {
    const load = win.load_kw[t];
    const pv = win.pv_per_kw[t] * d.pv_kw;
    const toLoad = Math.min(load, pv);
    let remaining = load - toLoad;
    let surplus = pv - toLoad;
    let charged = 0;
    let discharged = 0;

    for (const p of plans) {
      let dis = 0;
      if (remaining > 0) {
        let f = Math.min(remaining / p.P, 1);
        if (interp(p.fd, p.yd, f) > p.E / p.P) f = invert(p.fd, p.yd, p.E / p.P);
        if (f >= p.fd[0] && f > 0) {
          dis = f;
          p.E -= p.P * interp(p.fd, p.yd, f);
          remaining -= p.P * f;
        }
      }
      let chg = 0;
      if (surplus > 0) {
        let f = Math.min(surplus / p.P, 1);
        if (interp(p.fc, p.yc, f) > (p.band - p.E) / p.P) f = invert(p.fc, p.yc, (p.band - p.E) / p.P);
        if (f >= p.fc[0] && f > 0) {
          chg = f;
          p.E += p.P * interp(p.fc, p.yc, f);
          surplus -= p.P * f;
        }
      }
      const series = out.units[p.u.key];
      series.E.push(p.E);
      series.pc.push(p.P * chg);
      series.pd.push(p.P * dis);
      charged += p.P * chg;
      discharged += p.P * dis;
      cost += p.u.om_charge * p.P * chg + p.u.om_discharge * p.P * dis;
    }

    const imported = Math.min(remaining, d.grid_kw);
    const short = remaining - imported;
    // Below its minimum load the generator still runs at the minimum, and the excess backs off
    // the grid import, then exports, and only then is spilled.
    const dg = short > 1e-9 && d.diesel_kw > 0 ? Math.min(d.diesel_kw, Math.max(short, dieselMin)) : 0;
    const running = dg > 0 ? 1 : 0;
    const excess = Math.max(0, dg - short);
    const unserved = Math.max(0, short - dg);
    const exported = Math.min(surplus, d.grid_kw);
    const net = imported - exported - excess;
    const g = Math.max(-d.grid_kw, net);
    const spill = surplus - exported + (g - net);

    out.g.push(g);
    out.sp.push(spill);
    out.us.push(unserved);
    out.dg.push(dg);
    out.du.push(running);
    out.pc.push(charged);
    out.pd.push(discharged);
    cost += win.price[t] * g + d.pv_cost * pv + d.voll * unserved + d.spill_cost * spill;
    if (running) cost += dieselFuelCost(dg, 1, d);
  }
  return { status: "Rule-based", cost, series: out };
}

// Splits a result into the cost terms of the objective. Units is empty for the no-storage case.
// Cost of energy is the total divided by the load served, as in the conference paper.
export function costTerms(win, units, d, r) {
  const s = r.series;
  const total = (values) => values.reduce((a, x) => a + x, 0);
  const terms = {
    gridImport: total(s.g.map((g, t) => win.price[t] * Math.max(g, 0))),
    gridExport: -total(s.g.map((g, t) => win.price[t] * Math.max(-g, 0))),
    solar: d.pv_cost * total(win.pv_per_kw.map((x) => x * d.pv_kw)),
    storage: total(units.map((u) => u.om_charge * total(s.units[u.key].pc) + u.om_discharge * total(s.units[u.key].pd))),
    diesel: total(s.dg.map((kw, t) => (s.du[t] ? dieselFuelCost(kw, 1, d) : 0))),
    spill: d.spill_cost * total(s.sp),
    unserved: d.voll * total(s.us),
  };
  const sumTerms = total(Object.values(terms));
  const energy = total(win.load_kw);
  return { ...terms, total: sumTerms, coe: energy > 0 ? sumTerms / energy : null };
}

export function noStorage(win, d) {
  return { ...ruleBased(win, [], d), status: "No storage" };
}
