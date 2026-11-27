/* Draws the published forecast results from data/*.json. Charts only: no forecasting is done here. */
(function () {
  'use strict';

  var HOUR = 3600 * 1000, DAY = 24 * HOUR;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------- theme: follow the website (parent page) when embedded, else the visitor's setting ---------- */
  var embedded = false;
  try { embedded = window.self !== window.top && !!window.parent.document; } catch (e) { embedded = false; }
  if (embedded) document.documentElement.classList.add('embedded');
  /* ?preview: only the next-48-hours chart, for the card on the Projects page */
  var preview = /[?&]preview(&|=|$)/.test(location.search);
  if (preview) document.documentElement.classList.add('preview');

  function siteTheme() {
    try {
      if (embedded) {
        var t = window.parent.document.documentElement.getAttribute('data-theme');
        if (t === 'dark' || t === 'light') return t;
      }
    } catch (e) {}
    var s = null;
    try { s = localStorage.getItem('theme'); } catch (e) {}
    if (s === 'dark' || s === 'light') return s;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    var t = siteTheme();
    if (document.documentElement.getAttribute('data-theme') !== t) {
      document.documentElement.setAttribute('data-theme', t);
      return true;
    }
    return false;
  }
  applyTheme();

  function palette() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark ? {
      text: '#e5e7eb', muted: '#9ca3af', grid: 'rgba(229,231,235,0.12)',
      meas: '#f3f4f6', f1: '#60a5fa', f2: '#fbbf24', band: 'rgba(96,165,250,0.22)', base: '#9ca3af',
      clean: '#34d399', dirty: '#f87171'
    } : {
      text: '#1f2937', muted: '#4b5563', grid: 'rgba(31,41,55,0.10)',
      meas: '#111827', f1: '#2563eb', f2: '#d97706', band: 'rgba(37,99,235,0.16)', base: '#6b7280',
      clean: '#059669', dirty: '#dc2626'
    };
  }

  /* ---------- time helpers (all times are IST, kept as plain UTC numbers so no time zone shifts) ---------- */
  function ms(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13) || 0); }
  function d2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { return d2(new Date(t).getUTCHours()) + ':00'; }
  function dayLabel(t, withWeekday) {
    var d = new Date(t);
    return (withWeekday ? WDAYS[d.getUTCDay()] + ' ' : '') + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }
  function fullLabel(t) { return dayLabel(t, true) + ' ' + new Date(t).getUTCFullYear() + ', ' + hhmm(t); }
  function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }
  function stamp(s) { return dayLabel(ms(s), false) + ' ' + s.slice(0, 4) + ', ' + s.slice(11, 16); }
  function istToday() { var n = Date.now() + 5.5 * HOUR; return Date.UTC(new Date(n).getUTCFullYear(), new Date(n).getUTCMonth(), new Date(n).getUTCDate()); }
  function fmt(v, dp) { return v == null || isNaN(v) ? '–' : v.toFixed(dp); }

  function getJSON(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(path + ': ' + r.status);
      return r.json();
    });
  }

  /* ---------- chart defaults ---------- */
  function setDefaults() {
    var p = palette();
    Chart.defaults.font.family = '"Times New Roman", Times, serif';
    Chart.defaults.font.size = 14;
    Chart.defaults.color = p.text;
    Chart.defaults.borderColor = p.grid;
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
  }

  function timeAxis(min, max, step, p) {
    return {
      type: 'linear', min: min, max: max,
      grid: { color: p.grid },
      afterBuildTicks: function (axis) {
        var ticks = [];
        for (var t = min; t <= max; t += step) ticks.push({ value: t });
        axis.ticks = ticks;
      },
      ticks: {
        maxRotation: 0, autoSkip: true,
        callback: function (v) {
          var d = new Date(v);
          return d.getUTCHours() === 0 ? dayLabel(v, step >= DAY) : hhmm(v);
        }
      }
    };
  }

  var charts = {};
  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }

  function legend(id, items) {
    document.getElementById(id).innerHTML = items.map(function (it) {
      var style = it.box ? 'background:' + it.color : (it.dot ? 'background:' + it.color : 'border-top-color:' + it.color);
      var cls = it.box ? 'box' : (it.dot ? 'dot' : (it.dash ? 'dash' : ''));
      return '<span><i class="' + cls + '" style="' + style + '"></i>' + it.label + '</span>';
    }).join('');
  }

  /* ---------- state ---------- */
  var index = null, latest = null, monthCache = {};

  /* ---------- next 48 hours ---------- */
  function extremes(hours, n) {
    var sorted = hours.slice().sort(function (a, b) { return a.f - b.f; });
    return { clean: sorted.slice(0, n), dirty: sorted.slice(-n) };
  }
  function runsText(list) {
    var ts = list.map(function (h) { return h.x; }).sort(function (a, b) { return a - b; });
    var out = [], start = ts[0], prev = ts[0];
    for (var i = 1; i <= ts.length; i++) {
      if (i < ts.length && ts[i] === prev + HOUR) { prev = ts[i]; continue; }
      out.push(hhmm(start) + '–' + (prev + HOUR - dayStart(prev) === DAY ? '24:00' : hhmm(prev + HOUR)));
      if (i < ts.length) { start = ts[i]; prev = ts[i]; }
    }
    return out.join(', ');
  }
  function dayStart(t) { return t - (t % DAY); }

  function renderNext() {
    var p = palette();
    var issue = ms(latest.issue_date);
    var hrs = latest.hours.map(function (h) { return { x: ms(h.t), f: h.f, lo: h.lo, hi: h.hi }; });
    var meas = latest.measured.filter(function (m) { return ms(m.t) >= issue; })
      .map(function (m) { return { x: ms(m.t), y: m.a }; });

    var clean = [], dirty = [], lines = [];
    [0, 1].forEach(function (d) {
      var day = hrs.slice(d * 24, d * 24 + 24);
      var e = extremes(day, 4);
      clean = clean.concat(e.clean); dirty = dirty.concat(e.dirty);
      var lo = e.clean[0], hi = e.dirty[e.dirty.length - 1];
      lines.push('<p><strong>' + dayLabel(day[0].x, true) + ':</strong> ' +
        '<span class="clean">cleanest ' + runsText(e.clean) + '</span> (lowest ' + Math.round(lo.f) + ' kg/MWh at ' + hhmm(lo.x) + '); ' +
        '<span class="dirty">most polluting ' + runsText(e.dirty) + '</span> (highest ' + Math.round(hi.f) + ' at ' + hhmm(hi.x) + ').</p>');
    });
    document.getElementById('next-hours').innerHTML = lines.join('');

    var meta = 'Issued for 00:00, ' + dayLabel(issue, true) + ' ' + latest.issue_date.slice(0, 4) +
      ' (IST), from data up to ' + stamp(latest.data_up_to) + '. Page data updated ' + stamp(latest.updated_at) + ' IST.';
    if (preview) {
      meta = 'Forecast issued for 00:00, ' + dayLabel(issue, true) + ' ' + latest.issue_date.slice(0, 4) +
        ' (Indian Standard Time).';
      if (issue < istToday()) meta += ' <span class="warn">Today’s forecast has not been published yet; this is the latest one.</span>';
    } else if (latest.note && latest.made_at) {
      meta += ' This forecast was computed later, at ' + latest.made_at.slice(11, 16) + ' on ' + dayLabel(ms(latest.made_at), false) +
        ', but only from data up to the previous midnight, so it equals one issued at 00:00.';
    }
    if (issue < istToday()) meta += ' <span class="warn">Today’s forecast has not been published yet; this is the latest one.</span>';
    document.getElementById('next-meta').innerHTML = meta;

    draw('chart-next', {
      type: 'line',
      data: {
        datasets: [
          { label: 'lo', data: hrs.map(function (h) { return { x: h.x, y: h.lo }; }), borderWidth: 0, pointRadius: 0, fill: false },
          { label: '80 % range', data: hrs.map(function (h) { return { x: h.x, y: h.hi }; }), borderWidth: 0, pointRadius: 0,
            fill: '-1', backgroundColor: p.band },
          { label: 'Forecast', data: hrs.map(function (h) { return { x: h.x, y: h.f }; }), borderColor: p.f1, borderWidth: 2.5,
            pointRadius: 0, tension: 0.25 },
          { label: 'Measured so far', data: meas, borderColor: p.meas, backgroundColor: p.meas, borderWidth: 2, pointRadius: 2, spanGaps: false },
          { label: 'Cleanest hours', type: 'scatter', data: clean.map(function (h) { return { x: h.x, y: h.f }; }),
            pointRadius: 5, pointBackgroundColor: p.clean, pointBorderColor: p.clean },
          { label: 'Most polluting hours', type: 'scatter', data: dirty.map(function (h) { return { x: h.x, y: h.f }; }),
            pointRadius: 5, pointBackgroundColor: p.dirty, pointBorderColor: p.dirty }
        ]
      },
      options: {
        parsing: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: timeAxis(issue, issue + 47 * HOUR, 6 * HOUR, p),
          y: { title: { display: true, text: 'CO₂ intensity (kg/MWh)' }, grid: { color: p.grid } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (it) { return it.dataset.label !== 'lo' && it.dataset.type !== 'scatter'; },
            callbacks: {
              title: function (items) { return items.length ? fullLabel(items[0].parsed.x) : ''; },
              label: function (it) {
                if (it.dataset.label === '80 % range') {
                  var lo = it.chart.data.datasets[0].data[it.dataIndex].y;
                  return '80 % range: ' + Math.round(lo) + '–' + Math.round(it.parsed.y) + ' kg/MWh';
                }
                return it.dataset.label + ': ' + Math.round(it.parsed.y) + ' kg/MWh';
              }
            }
          }
        }
      }
    });
    legend('legend-next', [
      { label: 'Forecast', color: p.f1 },
      { label: '80 % range', color: p.band, box: true },
      { label: 'Measured so far', color: p.meas },
      { label: 'Four cleanest hours of each day', color: p.clean, dot: true },
      { label: 'Four most polluting hours of each day', color: p.dirty, dot: true }
    ]);
  }

  /* ---------- history ---------- */
  function monthsBetween(a, b) {
    var out = [], d = new Date(a);
    var y = d.getUTCFullYear(), m = d.getUTCMonth(), e = new Date(b);
    while (y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth())) {
      out.push(y + '-' + d2(m + 1));
      m++; if (m > 11) { m = 0; y++; }
    }
    return out.filter(function (k) { return index.months.indexOf(k) >= 0; });
  }
  function loadMonths(keys) {
    return Promise.all(keys.map(function (k) {
      if (monthCache[k]) return monthCache[k];
      monthCache[k] = getJSON('data/history/' + k + '.json');
      return monthCache[k];
    }));
  }

  function errors(rows, fk, ak) {
    var n = 0, sa = 0, sp = 0;
    rows.forEach(function (r) {
      if (r.a == null || r[fk] == null || (ak && !ak(r))) return;
      var e = Math.abs(r[fk] - r.a);
      n++; sa += e; sp += e / r.a;
    });
    return n ? { mape: 100 * sp / n, mae: sa / n, n: n } : { mape: null, mae: null, n: 0 };
  }

  function renderHistory() {
    var days = +document.getElementById('window').value;
    var end = ms(index.last_complete_day) + 23 * HOUR;
    var start = ms(index.last_complete_day) - (days - 1) * DAY;
    loadMonths(monthsBetween(start, end)).then(function (files) {
      var rows = [];
      files.forEach(function (f) { f.hours.forEach(function (h) { h.x = ms(h.t); if (h.x >= start && h.x <= end) rows.push(h); }); });
      rows.sort(function (a, b) { return a.x - b.x; });
      drawHistory(rows, start, end, days);
    }).catch(function (e) {
      document.getElementById('window-meta').textContent = 'Could not load the history (' + e.message + ').';
    });
  }

  function drawHistory(rows, start, end, days) {
    var p = palette();
    document.getElementById('window-meta').textContent =
      dayLabel(start, false) + ' to ' + dayLabel(end, false) + ' ' + new Date(end).getUTCFullYear() + ' (complete days only)';

    /* score table */
    var e1 = errors(rows, 'f1'), e2 = errors(rows, 'f2');
    var b1 = errors(rows, 'p1', function (r) { return r.f1 != null; });
    var b2 = errors(rows, 'p2', function (r) { return r.f2 != null; });
    var body = [
      ['main', 'Mean absolute percentage error', fmt(e1.mape, 2) + ' %', fmt(e2.mape, 2) + ' %'],
      ['main', 'Mean absolute error (kg/MWh)', fmt(e1.mae, 1), fmt(e2.mae, 1)],
      ['sub', 'Baseline “yesterday repeated”: percentage error', fmt(b1.mape, 2) + ' %', fmt(b2.mape, 2) + ' %'],
      ['sub', 'Baseline “yesterday repeated”: absolute error (kg/MWh)', fmt(b1.mae, 1), fmt(b2.mae, 1)],
      ['sub', 'Measured hours scored', String(e1.n), String(e2.n)]
    ];
    document.querySelector('#scores tbody').innerHTML = body.map(function (r) {
      return '<tr class="' + r[0] + '"><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>';
    }).join('');

    /* hourly chart (no live / computed-afterwards marking in the history, user 2026-11-27) */
    var pts = function (key) { return rows.map(function (r) { return { x: r.x, y: r[key] == null ? null : r[key] }; }); };
    var thin = days > 14;
    var step = days <= 2 ? 6 * HOUR : (days <= 7 ? DAY : (days <= 14 ? 2 * DAY : 5 * DAY));
    draw('chart-hist', {
      type: 'line',
      data: {
        datasets: [
          { label: 'lo', data: pts('lo'), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
          { label: '80 % range of the same-day forecast', data: pts('hi'), borderWidth: 0, pointRadius: 0, fill: '-1',
            backgroundColor: p.band, spanGaps: false },
          { label: 'Measured', data: pts('a'), borderColor: p.meas, borderWidth: thin ? 1.5 : 2.2, pointRadius: 0, spanGaps: false },
          { label: 'Same-day forecast', data: pts('f1'), borderColor: p.f1, borderWidth: thin ? 1.2 : 1.8,
            pointRadius: 0, spanGaps: false },
          { label: 'Day-ahead forecast', data: pts('f2'), borderColor: p.f2, borderWidth: thin ? 1.2 : 1.8,
            borderDash: [5, 4], pointRadius: 0, spanGaps: false }
        ]
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: timeAxis(start, end, step, p),
          y: { title: { display: true, text: 'CO₂ intensity (kg/MWh)' }, grid: { color: p.grid } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (it) { return it.dataset.label !== 'lo' && it.parsed.y != null; },
            callbacks: {
              title: function (items) { return items.length ? fullLabel(items[0].parsed.x) : ''; },
              label: function (it) {
                var r = rows[it.dataIndex], ds = it.dataset;
                if (ds.label.indexOf('80 %') === 0) {
                  return '80 % range: ' + Math.round(r.lo) + '–' + Math.round(r.hi) + ' kg/MWh';
                }
                return ds.label + ': ' + Math.round(it.parsed.y) + ' kg/MWh';
              }
            }
          }
        }
      }
    });
    legend('legend-hist', [
      { label: 'Measured', color: p.meas },
      { label: 'Same-day forecast', color: p.f1 },
      { label: 'Day-ahead forecast', color: p.f2, dash: true },
      { label: '80 % range', color: p.band, box: true }
    ]);

    /* daily errors */
    var byDay = {};
    rows.forEach(function (r) { var k = dayKey(r.x); (byDay[k] = byDay[k] || []).push(r); });
    var keys = Object.keys(byDay).sort();
    function daily(fk) {
      return keys.map(function (k) {
        var rs = byDay[k];
        var full = rs.length === 24 && rs.every(function (r) { return r[fk] != null; });
        return full ? errors(rs, fk).mape : null;
      });
    }
    var s1 = daily('f1'), s2 = daily('f2'), sb = daily('p1');
    function faded(c) { return c + 'aa'; }
    var c1 = p.f1, c2 = p.f2;
    draw('chart-daily', {
      type: 'bar',
      data: {
        labels: keys.map(function (k) { return dayLabel(ms(k), false); }),
        datasets: [
          { label: 'Same-day forecast', data: s1, backgroundColor: faded(c1), borderColor: c1, borderWidth: 1 },
          { label: 'Day-ahead forecast', data: s2, backgroundColor: faded(c2), borderColor: c2, borderWidth: 1 },
          { label: 'Yesterday repeated (same day)', type: 'line', data: sb,
            borderColor: p.base, backgroundColor: p.base, showLine: false, pointStyle: 'rectRot', pointRadius: 5 }
        ]
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, title: { display: true, text: 'Error (%)' }, grid: { color: p.grid } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: function (it) { return it.parsed.y != null; },
            callbacks: {
              title: function (items) { return items.length ? dayLabel(ms(keys[items[0].dataIndex]), true) : ''; },
              label: function (it) { return it.dataset.label + ': ' + it.parsed.y.toFixed(2) + ' %'; }
            }
          }
        }
      }
    });
    legend('legend-daily', [
      { label: 'Same-day forecast', color: c1, box: true },
      { label: 'Day-ahead forecast', color: c2, box: true },
      { label: 'Yesterday repeated (same day)', color: p.base, dot: true }
    ]);
  }

  /* ---------- start ---------- */
  function renderAll() {
    setDefaults();
    if (latest) renderNext();
    if (index && !preview) renderHistory();
  }

  Promise.all([getJSON('data/index.json'), getJSON('data/latest.json')]).then(function (res) {
    index = res[0]; latest = res[1];
    renderAll();
  }).catch(function (e) {
    document.getElementById('next-meta').textContent = 'The forecast could not be loaded (' + e.message + ').';
  });
  document.getElementById('window').addEventListener('change', renderHistory);

  /* Redraw in the new colours when the site's light/dark switch is used. */
  function watchTheme() { if (applyTheme()) renderAll(); }
  try {
    if (embedded) new MutationObserver(watchTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', watchTheme);
  }
  window.addEventListener('storage', watchTheme);
})();
