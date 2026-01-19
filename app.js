/* =========================================================
   TasPorts Public Dashboard — app.js
   - Dual tiles: 6-day (left) + 15-day (right)
   - Map: black markers + permanent site name labels
   - Calibration section: reads calibration.json (supports items[] or sites{})
   - Charts: raw-data embeds only
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
