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
   LIVE TILES (from public/data)
---------------------------- */
async function fetchLatestFromEagleDataUrl(dataUrl) {
  const resp = await fetch(dataUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} for ${dataUrl}`);
  const text = await resp.text();

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

function classifyTurbidity(value) {
  // Placeholder thresholds - update once client confirms
  if (value >= 10) return "red";
  if (value >= 5) return "amber";
  return "green";
}

function isStale(isoTs) {
  if (!isoTs) return false;
  const t = Date.parse(isoTs);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) > 24 * 60 * 60 * 1000;
}

function formatFnu(value) {
  return `${value.toFixed(2)} FNU`;
}

async function renderTurbidityTiles(stations) {
  const container = document.getElementById("turbidity-tiles");
  if (!container) return {};

  container.innerHTML = `<div class="tiles-loading">Loading turbidity…</div>`;

  const tiles = [];

  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];
    for (const level of sensors) {
      // IMPORTANT: your stations.json uses "values", not "data"
      const url = s?.values?.[level]?.turbidity || "";
      if (!url) {
        tiles.push({ stationId: s.id, stationName: s.name, level, error: true, reason: "missing url" });
        continue;
      }

      try {
        const latest = await fetchLatestFromEagleDataUrl(url);
        if (!latest) {
          tiles.push({ stationId: s.id, stationName: s.name, level, error: true, reason: "no data lines" });
          continue;
        }

        tiles.push({
          stationId: s.id,
          stationName: s.name,
          level,
          value: latest.value,
          timestamp: latest.timestamp,
          stale: isStale(latest.timestamp),
          error: false
        });
      } catch (e) {
        console.warn(`[Tile error] ${s.name} ${level} turbidity: ${url}`, e);
        tiles.push({ stationId: s.id, stationName: s.name, level, error: true, reason: "fetch error" });
      }
    }
  }

  if (!tiles.length) {
    container.innerHTML = `<div class="tiles-loading">No turbidity links configured.</div>`;
    return {};
  }

  container.innerHTML = tiles.map(t => {
    const title = `${t.stationName} – ${String(t.level).toUpperCase()}`;

    let cls = "tile gray";
    if (!t.error) {
      if (t.stale) cls = "tile gray"; // stale shown as grey for now
      else cls = `tile ${classifyTurbidity(t.value)}`;
    }

    const valueHtml = t.error
      ? `<div class="tile-value">—</div><div class="tile-sub">No data / error</div>`
      : `<div class="tile-value">${formatFnu(t.value)}</div>
         <div class="tile-sub">${new Date(t.timestamp).toLocaleString()}${t.stale ? " (stale)" : ""}</div>`;

    return `
      <button class="${cls}" data-station="${t.stationId}" aria-label="${title}">
        <div class="tile-title">${title}</div>
        ${valueHtml}
      </button>
    `;
  }).join("");

  container.querySelectorAll("button[data-station]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-station");
      window.location.href = `charts.html?station=${encodeURIComponent(id)}`;
    });
  });

  // Build summary for map colouring + popups
  const latestByStation = {};
  for (const t of tiles) {
    if (!latestByStation[t.stationId]) latestByStation[t.stationId] = { levels: {} };
    latestByStation[t.stationId].levels[t.level] = t.error
      ? { ok: false }
      : { ok: true, value: t.value, timestamp: t.timestamp, stale: t.stale };
  }

  return latestByStation;
}

/* ---------------------------
   MAP (index page)
---------------------------- */
function initMap(stations, latestByStation = {}) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  const map = L.map("map", { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const bounds = [];

  const rank = { red: 3, amber: 2, green: 1, unknown: 0 };

  function stationStatus(stationId) {
    const rec = latestByStation[stationId];
    if (!rec || !rec.levels) return { status: "unknown", labelLines: [] };

    const labelLines = [];
    let worst = "unknown";
    let anyError = false;
    let anyStale = false;

    for (const lvl of Object.keys(rec.levels)) {
      const item = rec.levels[lvl];
      if (!item || item.ok === false) {
        anyError = true;
        labelLines.push(`${lvl.toUpperCase()}: — (error)`);
        continue;
      }

      const cls = classifyTurbidity(item.value);
      if (rank[cls] > rank[worst]) worst = cls;

      if (item.stale) anyStale = true;

      const tsText = item.timestamp ? new Date(item.timestamp).toLocaleString() : "—";
      labelLines.push(`${lvl.toUpperCase()}: ${item.value.toFixed(2)} FNU (${tsText}${item.stale ? ", stale" : ""})`);
    }

    if (anyError && worst === "unknown") return { status: "error", labelLines };
    if (anyStale) return { status: "stale", labelLines };
    return { status: worst, labelLines };
  }

  function styleFor(status) {
    // Filled circle markers with black outline
    if (status === "red") return { fillColor: "#ff3c3c", fillOpacity: 0.90, color: "#000", weight: 2 };
    if (status === "amber") return { fillColor: "#ffbe00", fillOpacity: 0.90, color: "#000", weight: 2 };
    if (status === "green") return { fillColor: "#00ff78", fillOpacity: 0.90, color: "#000", weight: 2 };
    if (status === "stale") return { fillColor: "#9aa3b2", fillOpacity: 0.55, color: "#000", weight: 2 };
    if (status === "error") return { fillColor: "#9aa3b2", fillOpacity: 0.25, color: "#000", weight: 2, dashArray: "4 3" };
    return { fillColor: "#9aa3b2", fillOpacity: 0.35, color: "#000", weight: 2 };
  }

  stations.forEach(st => {
    const coords = st.coords;
    if (!Array.isArray(coords) || coords.length !== 2) return;
    const [lat, lon] = coords;

    bounds.push([lat, lon]);

    const info = stationStatus(st.id);
    const sty = styleFor(info.status);

    const dot = L.circleMarker([lat, lon], {
      radius: 9,
      ...sty,
      className: "marker-dot"
    }).addTo(map);

    const popupHtml = `
      <strong>${st.name}</strong><br/>
      ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/><br/>
      <em>Turbidity (15-day median):</em><br/>
      ${info.labelLines.length ? info.labelLines.join("<br/>") : "No data"}<br/><br/>
      <a href="charts.html?station=${encodeURIComponent(st.id)}">Open charts</a>
    `;

    dot.bindPopup(popupHtml);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

  // Legend
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML = `
      <div class="legend-title">Turbidity status</div>
      <div class="legend-item"><span class="legend-swatch green"></span> Compliant</div>
      <div class="legend-item"><span class="legend-swatch amber"></span> Alert</div>
      <div class="legend-item"><span class="legend-swatch red"></span> Exceedance</div>
      <div class="legend-item"><span class="legend-swatch stale"></span> Stale (&gt;24h)</div>
      <div class="legend-item"><span class="legend-swatch error"></span> Error / missing</div>
    `;
    return div;
  };
  legend.addTo(map);
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
      const latestByStation = await renderTurbidityTiles(stations);
      initMap(stations, latestByStation);

      // Refresh tiles periodically (map refresh can be added later if needed)
      setInterval(() => renderTurbidityTiles(stations), 5 * 60 * 1000);
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
