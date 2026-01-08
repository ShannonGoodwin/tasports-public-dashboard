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
   Helpers: station schema
   - supports either stations[].data or stations[].values
---------------------------- */
function getStationFeeds(station) {
  return station?.data || station?.values || {};
}

function labelForParam(paramKey) {
  if (paramKey === "turbidity") return "Turbidity (15-day running median)";
  if (paramKey === "do") return "Dissolved oxygen";
  if (paramKey === "ph") return "pH";
  if (paramKey === "temp") return "Temperature";
  if (paramKey === "tss") return "Total suspended solids (TSS)";
  return paramKey.toUpperCase();
}

/* ---------------------------
   LIVE TILES / DATA FETCH
---------------------------- */
async function fetchLatestFromEagleDataUrl(dataUrl) {
  const resp = await fetch(dataUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
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

function turbidityClass(value) {
  // Placeholder thresholds — identical to tiles
  if (value >= 10) return "red";
  if (value >= 5) return "amber";
  return "green";
}

function worstClass(classes) {
  // red > amber > green > gray
  if (classes.includes("red")) return "red";
  if (classes.includes("amber")) return "amber";
  if (classes.includes("green")) return "green";
  return "gray";
}

function formatValue(paramKey, value) {
  if (paramKey === "turbidity") return `${value.toFixed(2)} FNU`;
  if (paramKey === "temp") return `${value.toFixed(2)} °C`;
  if (paramKey === "ph") return `${value.toFixed(2)}`;
  if (paramKey === "do") return `${value.toFixed(2)}`;
  return `${value.toFixed(2)}`;
}

/* ---------------------------
   Index parameter tabs (landing page)
   - turbidity only for now
---------------------------- */
function initIndexTabs() {
  const panel = document.querySelector(".panel");
  if (!panel) return;
  if (document.getElementById("param-tabs")) return;

  const tabs = document.createElement("div");
  tabs.id = "param-tabs";
  tabs.className = "param-tabs";
  tabs.innerHTML = `
    <button class="tab tab-active" data-param="turbidity">Turbidity (15-day median)</button>
  `;

  const h2 = panel.querySelector("h2");
  if (h2 && h2.nextSibling) {
    h2.parentNode.insertBefore(tabs, h2.nextSibling);
  } else if (h2) {
    h2.parentNode.appendChild(tabs);
  }
}

async function renderParameterTiles(stations, paramKey) {
  const container = document.getElementById("turbidity-tiles");
  if (!container) return;

  container.innerHTML = `<div class="tiles-loading">Loading ${labelForParam(paramKey)}…</div>`;

  const tiles = [];

  for (const s of stations) {
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];
    const feeds = getStationFeeds(s);

    for (const level of sensors) {
      const url = feeds?.[level]?.[paramKey] || "";
      if (!url) continue;

      try {
        const latest = await fetchLatestFromEagleDataUrl(url);
        if (!latest) {
          tiles.push({ stationId: s.id, stationName: s.name, level, error: true });
          continue;
        }

        tiles.push({
          stationId: s.id,
          stationName: s.name,
          level,
          value: latest.value,
          timestamp: latest.timestamp
        });
      } catch (e) {
        tiles.push({ stationId: s.id, stationName: s.name, level, error: true });
      }
    }
  }

  if (!tiles.length) {
    container.innerHTML = `<div class="tiles-loading">No public data links configured for ${labelForParam(paramKey)}.</div>`;
    return;
  }

  container.innerHTML = tiles.map(t => {
    const title = `${t.stationName} – ${String(t.level).toUpperCase()}`;
    const valueHtml = t.error
      ? `<div class="tile-value">—</div><div class="tile-sub">No data / error</div>`
      : `<div class="tile-value">${formatValue(paramKey, t.value)}</div><div class="tile-sub">${new Date(t.timestamp).toLocaleString()}</div>`;

    const cls = t.error
      ? "tile gray"
      : (paramKey === "turbidity" ? `tile ${turbidityClass(t.value)}` : "tile");

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
}

/* ---------------------------
   MAP (index page) with coloured markers
   - Colour is based on worst-case turbidity (top/bottom)
   - Uses same turbidity thresholds as tiles
---------------------------- */
async function buildLatestTurbidityIndex(stations) {
  // Returns a map stationId -> { top, bottom, worstClass }
  const out = {};

  for (const s of stations) {
    const feeds = getStationFeeds(s);
    const sensors = Array.isArray(s.sensors) ? s.sensors : ["top"];

    const perLevel = {};
    const classes = [];

    for (const level of sensors) {
      const url = feeds?.[level]?.turbidity || "";
      if (!url) continue;

      try {
        const latest = await fetchLatestFromEagleDataUrl(url);
        if (!latest) {
          perLevel[level] = { error: true };
          continue;
        }
        const cls = turbidityClass(latest.value);
        perLevel[level] = { value: latest.value, timestamp: latest.timestamp, cls };
        classes.push(cls);
      } catch (e) {
        perLevel[level] = { error: true };
      }
    }

    out[s.id] = {
      perLevel,
      worst: classes.length ? worstClass(classes) : "gray"
    };
  }

  return out;
}

function markerStyleForClass(cls) {
  // Use circle markers with coloured stroke
  // (fill kept subtle so map stays readable)
  if (cls === "red") return { color: "rgba(255, 60, 60, 0.95)", fillColor: "rgba(255, 60, 60, 0.25)" };
  if (cls === "amber") return { color: "rgba(255, 190, 0, 0.95)", fillColor: "rgba(255, 190, 0, 0.22)" };
  if (cls === "green") return { color: "rgba(0, 255, 120, 0.95)", fillColor: "rgba(0, 255, 120, 0.18)" };
  return { color: "rgba(160, 160, 160, 0.95)", fillColor: "rgba(160, 160, 160, 0.18)" };
}

function buildPopupHtml(st, turbIndex) {
  const coords = st.coords;
  const [lat, lon] = Array.isArray(coords) && coords.length === 2 ? coords : [null, null];

  const entry = turbIndex?.[st.id];
  const perLevel = entry?.perLevel || {};
  const worst = entry?.worst || "gray";

  const rows = [];

  ["top", "bottom"].forEach(level => {
    if (!st.sensors?.includes(level)) return;
    const d = perLevel[level];
    const label = level.toUpperCase();

    if (!d) {
      rows.push(`<div>${label}: <em>Not configured</em></div>`);
      return;
    }
    if (d.error) {
      rows.push(`<div>${label}: <em>No data / error</em></div>`);
      return;
    }
    rows.push(`<div>${label}: <strong>${formatValue("turbidity", d.value)}</strong> <span class="small subtle">(${new Date(d.timestamp).toLocaleString()})</span></div>`);
  });

  const statusText =
    worst === "red" ? "Exceedance (draft thresholds)" :
    worst === "amber" ? "Alert (draft thresholds)" :
    worst === "green" ? "Compliant (draft thresholds)" :
    "No classification";

  return `
    <strong>${st.name}</strong><br/>
    ${lat !== null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>` : ""}
    <div class="small subtle" style="margin-top:6px;">Turbidity (15-day median):</div>
    ${rows.join("")}
    <div class="small subtle" style="margin-top:6px;"><strong>Status:</strong> ${statusText}</div>
    <div style="margin-top:8px;">
      <a href="charts.html?station=${encodeURIComponent(st.id)}">Open charts</a>
    </div>
  `;
}

async function initMap(stations) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  const map = L.map("map", { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Build turbidity index once for markers
  const turbIndex = await buildLatestTurbidityIndex(stations);

  const bounds = [];

  stations.forEach(st => {
    const coords = st.coords;
    if (!Array.isArray(coords) || coords.length !== 2) return;
    const [lat, lon] = coords;

    bounds.push([lat, lon]);

    const cls = turbIndex?.[st.id]?.worst || "gray";
    const style = markerStyleForClass(cls);

    const marker = L.circleMarker([lat, lon], {
      radius: 9,
      weight: 3,
      opacity: 1,
      fillOpacity: 0.8,
      ...style
    }).addTo(map);

    marker.bindPopup(buildPopupHtml(st, turbIndex));
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
      initIndexTabs();

      // Build map with coloured markers (uses turbidity data)
      await initMap(stations);

      // Landing page: turbidity tiles only
      let currentParam = "turbidity";
      await renderParameterTiles(stations, currentParam);

      setInterval(() => renderParameterTiles(stations, currentParam), 5 * 60 * 1000);
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
