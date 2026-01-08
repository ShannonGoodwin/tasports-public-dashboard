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
  // Prefer "data" if present, else fall back to "values"
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
   LIVE TILES (from public/data)
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
  // Placeholder thresholds
  if (value >= 10) return "tile red";
  if (value >= 5) return "tile amber";
  return "tile green";
}

function formatValue(paramKey, value) {
  if (paramKey === "turbidity") return `${value.toFixed(2)} FNU`;
  if (paramKey === "temp") return `${value.toFixed(2)} °C`;
  if (paramKey === "ph") return `${value.toFixed(2)}`;
  if (paramKey === "do") return `${value.toFixed(2)}`; // units TBD (mg/L or % sat) – keep numeric until confirmed
  return `${value.toFixed(2)}`;
}

async function renderParameterTiles(stations, paramKey) {
  const container = document.getElementById("turbidity-tiles"); // same container on index
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

    // Only turbidity has colour thresholds for now
    const cls = t.error
      ? "tile gray"
      : (paramKey === "turbidity" ? turbidityClass(t.value) : "tile");

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
   Index parameter tabs (landing page)
   - For now we expose turbidity only
   - We keep DO/pH/temp hidden until client decides
---------------------------- */
function initIndexTabs() {
  const panel = document.querySelector(".panel");
  if (!panel) return;

  // Insert a tiny tab bar under the H2 if it isn’t already there
  const existing = document.getElementById("param-tabs");
  if (existing) return;

  const tabs = document.createElement("div");
  tabs.id = "param-tabs";
  tabs.className = "param-tabs";
  tabs.innerHTML = `
    <button class="tab tab-active" data-param="turbidity">Turbidity (15-day median)</button>
    <!-- Future options (keep commented until client confirms):
    <button class="tab" data-param="do">DO</button>
    <button class="tab" data-param="ph">pH</button>
    <button class="tab" data-param="temp">Temp</button>
    -->
  `;

  // Put tabs right after the H2
  const h2 = panel.querySelector("h2");
  if (h2 && h2.nextSibling) {
    h2.parentNode.insertBefore(tabs, h2.nextSibling);
  } else if (h2) {
    h2.parentNode.appendChild(tabs);
  }
}

/* ---------------------------
   MAP (index page)
---------------------------- */
function initMap(stations) {
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

    const marker = L.marker([lat, lon]).addTo(map);
    marker.bindPopup(`
      <strong>${st.name}</strong><br/>
      ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>
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
    if (charts.tss) blocks.push(buildChartCard(charts.tss, `${s.name} – ${String(level).toUpperCase()} – TSS`));
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
      initMap(stations);
      initIndexTabs();

      // Landing page: show turbidity only for now
      let currentParam = "turbidity";
      await renderParameterTiles(stations, currentParam);

      // Wire future tab behaviour (only turbidity exists right now)
      const tabs = document.getElementById("param-tabs");
      if (tabs) {
        tabs.addEventListener("click", async (e) => {
          const btn = e.target.closest("button[data-param]");
          if (!btn) return;

          const param = btn.getAttribute("data-param");
          if (!param) return;

          // update UI
          tabs.querySelectorAll(".tab").forEach(b => b.classList.remove("tab-active"));
          btn.classList.add("tab-active");

          currentParam = param;
          await renderParameterTiles(stations, currentParam);
        });
      }

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
