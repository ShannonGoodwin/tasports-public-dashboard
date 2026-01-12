const STALE_HOURS = 24;

// These are placeholder thresholds for v1 (same as tiles previously).
// Change later once client confirms triggers.
const THRESHOLDS = {
  amber: 5,
  red: 10
};

async function loadStations() {
  const res = await fetch("stations.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load stations.json");
  const data = await res.json();
  return data.stations || [];
}

function currentPage() {
  const p = (window.location.pathname || "").toLowerCase();
  if (p.endsWith("/charts.html")) return "charts";
  return "index";
}

function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* ---------------------------
   EAGLE PUBLIC/DATA FETCH
---------------------------- */

function parseEagleCsvText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
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

function hoursSince(tsIso) {
  const t = Date.parse(tsIso);
  if (!Number.isFinite(t)) return Infinity;
  const diffMs = Date.now() - t;
  return diffMs / (1000 * 60 * 60);
}

function classifyValue(value) {
  if (value >= THRESHOLDS.red) return "red";
  if (value >= THRESHOLDS.amber) return "amber";
  return "green";
}

function isStale(tsIso) {
  return hoursSince(tsIso) > STALE_HOURS;
}

async function fetchLatestFromEagleDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return { ok: false, reason: "Missing link" };
  }

  let resp;
  try {
    resp = await fetch(dataUrl, { cache: "no-store" });
  } catch (e) {
    return { ok: false, reason: "Fetch failed (network)" };
  }

  if (!resp.ok) {
    return { ok: false, reason: `Fetch failed (HTTP ${resp.status})` };
  }

  const text = await resp.text();
  const parsed = parseEagleCsvText(text);

  if (!parsed) {
    return { ok: false, reason: "No data returned" };
  }

  const stale = isStale(parsed.timestamp);
  return {
    ok: true,
    timestamp: parsed.timestamp,
    value: parsed.value,
    stale
  };
}

function formatFnu(value) {
  return `${value.toFixed(2)} FNU`;
}

function prettyTime(tsIso) {
  try {
    return new Date(tsIso).toLocaleString();
  } catch {
    return tsIso;
  }
}

/* ---------------------------
   LIVE TURBIDITY MODEL
   Build one consistent dataset used by:
   - tiles
   - map marker colour
   - popup details
---------------------------- */

async function buildTurbiditySnapshot(stations) {
  // Returns:
  // {
  //   perSensor: { "<stationId>:<top|bottom>": { ok, value, timestamp, stale, reason } }
  //   perStation: { "<stationId>": { className, summaryLines[], anyOk } }
  // }
  const perSensor = {};
  const perStation = {};

  // Fetch sequentially (fine at 10 sensors); keeps it simple and predictable.
  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];

    for (const level of sensors) {
      // IMPORTANT: your stations.json uses "values", not "data"
      const url = s?.values?.[level]?.turbidity || "";
      const key = `${s.id}:${level}`;

      const r = await fetchLatestFromEagleDataUrl(url);
      perSensor[key] = r;
    }
  }

  // Station-level classification = worst-case across sensors.
  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];
    const results = sensors.map(level => ({
      level,
      res: perSensor[`${s.id}:${level}`]
    }));

    // If none OK => gray
    const okResults = results.filter(x => x.res && x.res.ok && !x.res.stale);
    const staleResults = results.filter(x => x.res && x.res.ok && x.res.stale);

    let stationClass = "gray";
    let anyOk = false;

    if (okResults.length) {
      anyOk = true;
      // Determine worst classification among non-stale OK sensors
      let worst = "green";
      for (const x of okResults) {
        const c = classifyValue(x.res.value);
        if (c === "red") { worst = "red"; break; }
        if (c === "amber") worst = "amber";
      }
      stationClass = worst;
    } else if (staleResults.length) {
      stationClass = "gray"; // treat stale as gray (per your requirement)
    } else {
      stationClass = "gray";
    }

    const summaryLines = results.map(x => {
      const label = String(x.level).toUpperCase();
      if (!x.res) return `${label}: — (No result)`;
      if (!x.res.ok) return `${label}: — (${x.res.reason})`;
      if (x.res.stale) return `${label}: ${formatFnu(x.res.value)} (STALE: ${prettyTime(x.res.timestamp)})`;
      return `${label}: ${formatFnu(x.res.value)} (${prettyTime(x.res.timestamp)})`;
    });

    perStation[s.id] = { className: stationClass, summaryLines, anyOk };
  }

  return { perSensor, perStation };
}

/* ---------------------------
   LIVE TILES
---------------------------- */

function tileCssClassFromSensorResult(res) {
  if (!res || !res.ok) return "tile gray";
  if (res.stale) return "tile gray";
  const c = classifyValue(res.value);
  return `tile ${c}`;
}

function tileSubtitleFromSensorResult(res) {
  if (!res || !res.ok) return res?.reason || "No data / error";
  if (res.stale) return `STALE (> ${STALE_HOURS}h): ${prettyTime(res.timestamp)}`;
  return prettyTime(res.timestamp);
}

async function renderTurbidityTiles(stations, snapshot) {
  const container = document.getElementById("turbidity-tiles");
  if (!container) return;

  container.innerHTML = `<div class="tiles-loading">Loading turbidity…</div>`;

  const tilesHtml = [];

  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];
    for (const level of sensors) {
      const key = `${s.id}:${level}`;
      const res = snapshot.perSensor[key];

      const title = `${s.name} – ${String(level).toUpperCase()}`;
      const cls = tileCssClassFromSensorResult(res);

      const valueHtml = (res && res.ok && !res.stale)
        ? `<div class="tile-value">${formatFnu(res.value)}</div>`
        : (res && res.ok && res.stale)
          ? `<div class="tile-value">${formatFnu(res.value)}</div>`
          : `<div class="tile-value">—</div>`;

      const sub = tileSubtitleFromSensorResult(res);

      tilesHtml.push(`
        <button class="${cls}" data-station="${s.id}" aria-label="${title}">
          <div class="tile-title">${title}</div>
          ${valueHtml}
          <div class="tile-sub">${sub}</div>
        </button>
      `);
    }
  }

  container.innerHTML = tilesHtml.join("") || `<div class="tiles-loading">No turbidity links configured.</div>`;

  container.querySelectorAll("button[data-station]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-station");
      window.location.href = `charts.html?station=${encodeURIComponent(id)}`;
    });
  });
}

/* ---------------------------
   MAP (filled circle markers)
---------------------------- */

function colorForClass(c) {
  if (c === "red") return "rgba(255,60,60,0.85)";
  if (c === "amber") return "rgba(255,190,0,0.85)";
  if (c === "green") return "rgba(0,255,120,0.85)";
  return "rgba(170,170,170,0.75)";
}

function initMap(stations, snapshot) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  const map = L.map("map", { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const bounds = [];

  stations.forEach(st => {
    const coords = st.coords;
    if (!Array.isArray(coords) || coords.length !== 2) return;
    const [lat, lon] = coords;
    bounds.push([lat, lon]);

    const stationInfo = snapshot?.perStation?.[st.id] || { className: "gray", summaryLines: [] };
    const fill = colorForClass(stationInfo.className);

    // Filled circle marker with black outline (much easier to see)
    const marker = L.circleMarker([lat, lon], {
      radius: 9,
      color: "#0a0a0a",      // outline
      weight: 2,
      fillColor: fill,
      fillOpacity: 0.9
    }).addTo(map);

    const linesHtml = (stationInfo.summaryLines || []).map(l => `${l}`).join("<br/>");

    marker.bindPopup(`
      <strong>${st.name}</strong><br/>
      ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/><br/>
      <span class="small subtle">Turbidity (15-day median):</span><br/>
      ${linesHtml}<br/><br/>
      <a href="charts.html?station=${encodeURIComponent(st.id)}">Open charts</a>
    `);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

/* ---------------------------
   CHARTS PAGE (unchanged)
---------------------------- */

function buildStationOptions(stations) {
  const sel = document.getElementById("stationPicker");
  if (!sel) return;
  sel.innerHTML = stations.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
}

function buildChartCard(url, title) {
  if (!url) return "";
  return `
    <div class="chart-card">
      <div class="chart-card-head">
        <div class="chart-title">${title}</div>
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
    if (charts.tss) blocks.push(buildChartCard(charts.tss, `${s.name} – ${String(level).toUpperCase()} – TSS`));
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

    if (currentPage() === "index") {
      // Build one turbidity snapshot, then use it for tiles + map.
      const snapshot = await buildTurbiditySnapshot(stations);

      await renderTurbidityTiles(stations, snapshot);
      initMap(stations, snapshot);

      // refresh every 5 minutes
      setInterval(async () => {
        const snap = await buildTurbiditySnapshot(stations);
        await renderTurbidityTiles(stations, snap);
        // Map refresh is optional (Leaflet repainting markers is more work);
        // For v1, map refresh on reload is acceptable. If you want live marker refresh, tell me.
      }, 5 * 60 * 1000);
    }

    if (currentPage() === "charts") {
      initChartsPage(stations);
    }
  } catch (err) {
    console.error(err);
    const tiles = document.getElementById("turbidity-tiles");
    if (tiles) tiles.innerHTML = `<div class="tiles-loading">Failed to load configuration. Check stations.json.</div>`;
    const chartsMsg = document.getElementById("chartsMsg");
    if (chartsMsg) chartsMsg.textContent = "Failed to load configuration. Check stations.json.";
  }
})();
