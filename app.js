/* =========================================================
   TasPorts Public Dashboard — app.js
   - Dual tiles: 6-day (left) + 15-day (right)
   - Map: black markers + permanent site name labels
   - Calibration page: reads calibration.json (supports items[] or sites{})
   - Charts: embeds (no "(raw)" in headings)
========================================================= */

async function loadStations() {
  const res = await fetch("stations.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load stations.json");
  const data = await res.json();
  return data.stations || [];
}

function currentPage() {
  const p = (window.location.pathname || "").toLowerCase();
  if (p.endsWith("/charts.html")) return "charts";
  if (p.endsWith("/calibration.html")) return "calibration";
  return "index";
}

function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* ---------------------------
   LIVE DATA (public/data)
---------------------------- */
async function fetchLatestFromEagleDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") throw new Error("Missing data URL");
  if (!/^https:\/\/public\.eagle\.io\/public\/data\/[a-z0-9]+/i.test(dataUrl)) {
    throw new Error(`Unexpected data URL format: ${dataUrl}`);
  }

  const resp = await fetch(dataUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} for ${dataUrl}`);

  const text = await resp.text();

  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const dataLines = lines.filter(l => /^\d{4}-\d{2}-\d{2}T/.test(l));
  if (!dataLines.length) return null;

  const last = dataLines[dataLines.length - 1];
  const parts = last.split(",");
  if (parts.length < 2) return null;

  const ts = parts[0];
  const value = Number(parts[1]);
  if (!Number.isFinite(value)) return null;

  return { timestamp: ts, value };
}

function isStale(isoTs) {
  if (!isoTs) return false;
  const t = Date.parse(isoTs);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > 24 * 60 * 60 * 1000;
}

function formatFnu(value) {
  return `${value.toFixed(2)} FNU`;
}

/* ---------------------------
   THRESHOLDS (turbidity)
   NOTE: placeholders until you replace with AMMP-derived values
---------------------------- */
function classifyTurbidity(value) {
  if (value >= 10) return "red";
  if (value >= 5) return "amber";
  return "green";
}

/* ---------------------------
   URL LOOKUP (6d vs 15d)
---------------------------- */
function getTurbidityUrl(station, level, windowKey) {
  const v = station?.values?.[level] || {};

  if (windowKey === "6d") {
    return (
      v.turbidity_6d ||
      v.turbidity6 ||
      v.turbidity_6 ||
      v.turbidity6d ||
      v.turbidity_6day ||
      v.turbidity6day ||
      ""
    );
  }

  return (
    v.turbidity_15d ||
    v.turbidity15 ||
    v.turbidity_15 ||
    v.turbidity15d ||
    v.turbidity_15day ||
    v.turbidity15day ||
    v.turbidity || // fallback (assumed 15d)
    ""
  );
}

/* ---------------------------
   TILE RENDERING
---------------------------- */
function tileClassFor(t) {
  if (t.error) return "tile tile--error";
  if (t.stale) return "tile tile--stale";
  const cls = classifyTurbidity(t.value);
  return `tile tile--${cls}`;
}

function tileValueHtml(t) {
  if (t.error) {
    return `<div class="tile-value">—</div><div class="tile-sub">Error / missing</div>`;
  }
  return `<div class="tile-value">${formatFnu(t.value)}</div>
          <div class="tile-sub">${new Date(t.timestamp).toLocaleString()}${t.stale ? " (stale)" : ""}</div>`;
}

function tileTitle(stationName, level) {
  return `${stationName} – ${String(level).toUpperCase()}`;
}

function renderTilesInto(container, tiles) {
  container.innerHTML = tiles
    .map(t => {
      const title = tileTitle(t.stationName, t.level);
      return `
        <button class="${tileClassFor(t)}" data-station="${t.stationId}" aria-label="${escapeHtml(title)}">
          <div class="tile-title">${escapeHtml(title)}</div>
          ${tileValueHtml(t)}
        </button>
      `;
    })
    .join("");

  container.querySelectorAll("button[data-station]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-station");
      window.location.href = `charts.html?station=${encodeURIComponent(id)}`;
    });
  });
}

async function buildTurbidityTiles(stations, windowKey) {
  const tiles = [];

  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];

    for (const level of sensors) {
      const url = getTurbidityUrl(s, level, windowKey);

      if (!url) {
        tiles.push({
          stationId: s.id,
          stationName: s.name,
          level,
          windowKey,
          error: true,
          reason: `missing turbidity ${windowKey} URL`
        });
        continue;
      }

      try {
        const latest = await fetchLatestFromEagleDataUrl(url);
        if (!latest) {
          tiles.push({
            stationId: s.id,
            stationName: s.name,
            level,
            windowKey,
            error: true,
            reason: "no data lines found"
          });
          continue;
        }

        tiles.push({
          stationId: s.id,
          stationName: s.name,
          level,
          windowKey,
          value: latest.value,
          timestamp: latest.timestamp,
          stale: isStale(latest.timestamp),
          error: false
        });
      } catch (e) {
        console.warn(`[Tile error] ${s.name} ${level} turbidity ${windowKey}`, url, e);
        tiles.push({
          stationId: s.id,
          stationName: s.name,
          level,
          windowKey,
          error: true,
          reason: e?.message || "fetch error"
        });
      }
    }
  }

  const summary = {};
  for (const t of tiles) {
    if (!summary[t.stationId]) summary[t.stationId] = { byWindow: { "6d": {}, "15d": {} } };

    summary[t.stationId].byWindow[t.windowKey][t.level] = t.error
      ? { ok: false, reason: t.reason }
      : { ok: true, value: t.value, timestamp: t.timestamp, stale: t.stale };
  }

  return { tiles, summary };
}

async function renderDualTurbidityTiles(stations) {
  const el6 = document.getElementById("turbidity-tiles-6d");
  const el15 = document.getElementById("turbidity-tiles-15d");
  const legacy = document.getElementById("turbidity-tiles");

  if (el6) el6.innerHTML = `<div class="tiles-loading">Loading 6-day turbidity…</div>`;
  if (el15) el15.innerHTML = `<div class="tiles-loading">Loading 15-day turbidity…</div>`;
  if (!el6 && !el15 && legacy) legacy.innerHTML = `<div class="tiles-loading">Loading turbidity…</div>`;

  const [{ tiles: tiles6, summary: sum6 }, { tiles: tiles15, summary: sum15 }] = await Promise.all([
    buildTurbidityTiles(stations, "6d"),
    buildTurbidityTiles(stations, "15d")
  ]);

  if (el6) {
    if (!tiles6.length) el6.innerHTML = `<div class="tiles-loading">No 6-day links configured.</div>`;
    else renderTilesInto(el6, tiles6);
  }

  if (el15) {
    if (!tiles15.length) el15.innerHTML = `<div class="tiles-loading">No 15-day links configured.</div>`;
    else renderTilesInto(el15, tiles15);
  }

  if (!el6 && !el15 && legacy) {
    if (!tiles15.length) legacy.innerHTML = `<div class="tiles-loading">No turbidity links configured.</div>`;
    else renderTilesInto(legacy, tiles15);
  }

  const merged = {};
  for (const sid of new Set([...Object.keys(sum6), ...Object.keys(sum15)])) {
    merged[sid] = {
      byWindow: {
        "6d": sum6?.[sid]?.byWindow?.["6d"] || {},
        "15d": sum15?.[sid]?.byWindow?.["15d"] || {}
      }
    };
  }

  return merged;
}

/* ---------------------------
   MAP (index page)
---------------------------- */
let __mapState = null;

function initMap(stations) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return null;

  const map = L.map("map", { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const bounds = [];
  const markers = {};

  stations.forEach(st => {
    const coords = st.coords;
    if (!Array.isArray(coords) || coords.length !== 2) return;

    const [lat, lon] = coords;
    bounds.push([lat, lon]);

    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      fillColor: "#000",
      fillOpacity: 0.82,
      color: "#fff",
      weight: 2
    }).addTo(map);

    marker.bindTooltip(escapeHtml(st.name), {
      permanent: true,
      direction: "right",
      offset: [8, 0],
      className: "map-label",
      opacity: 0.95
    });

    marker.on("tooltipopen", (e) => {
      const el = e.tooltip.getElement();
      if (el) el.style.pointerEvents = "none";
    });

    markers[st.id] = marker;

    marker.on("click", () => {
      marker.openPopup();
    });
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

  return { map, markers };
}

function popupHtmlForStation(station, stationSummary) {
  const { name, id, coords } = station;
  const [lat, lon] = Array.isArray(coords) && coords.length === 2 ? coords : [null, null];

  function linesFor(windowKey, label) {
    const rec = stationSummary?.byWindow?.[windowKey] || {};

    const preferred = ["top", "bottom"];
    const lvls = preferred.filter(k => rec[k]).concat(Object.keys(rec).filter(k => !preferred.includes(k)));

    if (!lvls.length) return [`<span class="subtle small">${escapeHtml(label)}: not configured</span>`];

    const out = [];
    for (const lvl of lvls) {
      const item = rec[lvl];
      if (!item || item.ok === false) {
        out.push(`${lvl.toUpperCase()}: — (error${item?.reason ? `: ${escapeHtml(item.reason)}` : ""})`);
        continue;
      }
      const tsText = item.timestamp ? new Date(item.timestamp).toLocaleString() : "—";
      out.push(`${lvl.toUpperCase()}: ${item.value.toFixed(2)} FNU (${escapeHtml(tsText)}${item.stale ? ", stale" : ""})`);
    }
    return out;
  }

  const block6 = linesFor("6d", "6-day rolling median");
  const block15 = linesFor("15d", "15-day rolling median");

  return `
    <strong>${escapeHtml(name)}</strong><br/>
    ${lat != null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}<br/><br/>` : "<br/>"}
    <em>Turbidity:</em><br/>
    <span class="small subtle">6-day rolling median</span><br/>
    ${block6.join("<br/>")}<br/><br/>
    <span class="small subtle">15-day rolling median</span><br/>
    ${block15.join("<br/>")}<br/><br/>
    <a href="charts.html?station=${encodeURIComponent(id)}">Open charts</a>
  `;
}

function updateMapPopups(stations, summaryByStation) {
  if (!__mapState) return;
  const { markers } = __mapState;

  stations.forEach(st => {
    const marker = markers[st.id];
    if (!marker) return;

    const popupHtml = popupHtmlForStation(st, summaryByStation?.[st.id]);
    marker.bindPopup(popupHtml);
  });
}

/* ---------------------------
   CALIBRATION PAGE
---------------------------- */
async function renderCalibrationTable() {
  const host = document.getElementById("calibration-table");
  if (!host) return;

  try {
    const res = await fetch("calibration.json", { cache: "no-store" });
    if (!res.ok) {
      host.innerHTML = `<div class="small subtle">Calibration dates are not available.</div>`;
      return;
    }

    const data = await res.json();

    // Preferred schema: { items: [ {station, sensor, last_calibrated, notes}, ... ], last_updated }
    if (Array.isArray(data?.items)) {
      const rows = data.items
        .slice()
        .sort((a, b) => {
          const sa = `${a.station || ""}-${a.sensor || ""}`;
          const sb = `${b.station || ""}-${b.sensor || ""}`;
          return sa.localeCompare(sb);
        })
        .map(it => {
          const station = escapeHtml(it.station || "");
          const sensor = escapeHtml((it.sensor || "").toUpperCase());
          const date = escapeHtml(it.last_calibrated || "—");
          const notes = escapeHtml(it.notes || "");
          return `<tr><td>${station}</td><td>${sensor}</td><td>${date}</td><td>${notes}</td></tr>`;
        })
        .join("");

      host.innerHTML = rows
        ? `
          <table class="cal-table">
            <thead>
              <tr><th>Station</th><th>Sensor</th><th>Last calibrated</th><th>Notes</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${data?.last_updated ? `<div class="small subtle" style="margin-top:8px;">Last updated: ${escapeHtml(data.last_updated)}</div>` : ""}
        `
        : `<div class="small subtle">Calibration dates are not configured.</div>`;

      return;
    }

    // Legacy schema: { sites: { "Site name": "YYYY-MM-DD", ... }, last_updated }
    const sites = data?.sites || {};
    const rows = Object.entries(sites)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([site, date]) => `<tr><td>${escapeHtml(site)}</td><td>${escapeHtml(date || "—")}</td></tr>`)
      .join("");

    host.innerHTML = rows
      ? `
        <table class="cal-table">
          <thead><tr><th>Site</th><th>Last calibration</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${data?.last_updated ? `<div class="small subtle" style="margin-top:8px;">Last updated: ${escapeHtml(data.last_updated)}</div>` : ""}
      `
      : `<div class="small subtle">Calibration dates are not configured.</div>`;
  } catch (e) {
    console.warn("Calibration table load failed:", e);
    host.innerHTML = `<div class="small subtle">Calibration dates are not available.</div>`;
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ---------------------------
   CHARTS PAGE (embeds)
---------------------------- */
function buildStationOptions(stations) {
  const sel = document.getElementById("stationPicker");
  if (!sel) return;
  sel.innerHTML = stations.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function buildChartCard(url, title) {
  if (!url) return "";
  return `
    <div class="chart-card">
      <div class="chart-card-head">
        <div class="chart-title">${escapeHtml(title)}</div>
        <a class="chart-open" href="${url}" target="_blank" rel="noopener noreferrer">Open</a>
      </div>
      <iframe src="${url}" loading="lazy" referrerpolicy="no-referrer"></iframe>
    </div>
  `;
}

function renderChartsByStation(stations, stationId) {
  const container = document.getElementById("chartsContainer");
  const msg = document.getElementById("chartsMsg");
  if (!container || !msg) return;

  const s = stations.find(x => x.id === stationId);
  if (!s) {
    msg.textContent = "Station not found.";
    container.innerHTML = "";
    return;
  }

  msg.textContent = "";
  const blocks = [];
  const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];

  for (const level of sensors) {
    const charts = s?.charts?.[level] || {};
    if (charts.turbidity) blocks.push(buildChartCard(charts.turbidity, `${s.name} – ${String(level).toUpperCase()} – Turbidity`));
    if (charts.do) blocks.push(buildChartCard(charts.do, `${s.name} – ${String(level).toUpperCase()} – Dissolved oxygen`));
    if (charts.ph) blocks.push(buildChartCard(charts.ph, `${s.name} – ${String(level).toUpperCase()} – pH`));
    if (charts.temp) blocks.push(buildChartCard(charts.temp, `${s.name} – ${String(level).toUpperCase()} – Temperature`));
  }

  container.innerHTML = blocks.join("") || `<div class="small subtle">No charts configured for this station yet.</div>`;
}

function renderChartsByParameter(stations, paramKey) {
  const container = document.getElementById("chartsContainer");
  const msg = document.getElementById("chartsMsg");
  if (!container || !msg) return;

  msg.textContent = "";
  const blocks = [];

  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];
    for (const level of sensors) {
      const url = s?.charts?.[level]?.[paramKey] || "";
      if (!url) continue;

      let label = paramKey.toUpperCase();
      if (paramKey === "do") label = "Dissolved oxygen";
      if (paramKey === "temp") label = "Temperature";
      if (paramKey === "turbidity") label = "Turbidity";

      blocks.push(buildChartCard(url, `${s.name} – ${String(level).toUpperCase()} – ${label}`));
    }
  }

  container.innerHTML = blocks.join("") || `<div class="small subtle">No charts configured for this parameter yet.</div>`;
}

function initChartsPage(stations) {
  buildStationOptions(stations);

  const viewMode = document.getElementById("viewMode");
  const stationPicker = document.getElementById("stationPicker");
  const paramPicker = document.getElementById("paramPicker");
  const stationWrap = document.getElementById("stationPickerWrap");
  const paramWrap = document.getElementById("paramPickerWrap");

  const presetStation = getQueryParam("station");
  if (presetStation && stationPicker) stationPicker.value = presetStation;

  function refresh() {
    const mode = viewMode?.value || "station";
    if (mode === "station") {
      stationWrap.style.display = "";
      paramWrap.style.display = "none";
      renderChartsByStation(stations, stationPicker.value);
    } else {
      stationWrap.style.display = "none";
      paramWrap.style.display = "";
      renderChartsByParameter(stations, paramPicker.value);
    }
  }

  viewMode?.addEventListener("change", refresh);
  stationPicker?.addEventListener("change", refresh);
  paramPicker?.addEventListener("change", refresh);

  refresh();
}

/* ---------------------------
   BOOT
---------------------------- */
(async function main() {
  try {
    const stations = await loadStations();
    const page = currentPage();

    if (page === "index") {
      __mapState = initMap(stations);

      const summaryByStation = await renderDualTurbidityTiles(stations);
      updateMapPopups(stations, summaryByStation);

      setInterval(async () => {
        const sum = await renderDualTurbidityTiles(stations);
        updateMapPopups(stations, sum);
      }, 5 * 60 * 1000);
    }

    if (page === "charts") {
      initChartsPage(stations);
    }

    if (page === "calibration") {
      await renderCalibrationTable();
    }
  } catch (err) {
    console.error(err);

    const el6 = document.getElementById("turbidity-tiles-6d");
    const el15 = document.getElementById("turbidity-tiles-15d");
    const legacy = document.getElementById("turbidity-tiles");
    const msg = "Failed to load configuration. Check stations.json.";

    if (el6) el6.innerHTML = `<div class="tiles-loading">${msg}</div>`;
    if (el15) el15.innerHTML = `<div class="tiles-loading">${msg}</div>`;
    if (!el6 && !el15 && legacy) legacy.innerHTML = `<div class="tiles-loading">${msg}</div>`;

    const chartsMsg = document.getElementById("chartsMsg");
    if (chartsMsg) chartsMsg.textContent = msg;

    const calHost = document.getElementById("calibration-table");
    if (calHost) calHost.innerHTML = `<div class="small subtle">${msg}</div>`;
  }
})();
