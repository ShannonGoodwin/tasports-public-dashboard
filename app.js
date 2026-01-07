async function loadStations() {
  const res = await fetch("stations.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load stations.json");
  return res.json();
}

function statusBadge(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("exceed")) return `<span class="badge badge--bad">Exceedance</span>`;
  if (s.includes("alert")) return `<span class="badge badge--warn">Alert</span>`;
  return `<span class="badge badge--ok">Compliant</span>`;
}

function makeEmbedBlock(title, url) {
  if (!url) {
    return `
      <div class="embed">
        <div class="embed__head">
          <p class="small"><strong>${title}</strong></p>
          <p class="small subtle">Link not set</p>
        </div>
        <div style="padding:10px" class="small subtle">Add the public.eagle.io chart URL in stations.json</div>
      </div>
    `;
  }
  return `
    <div class="embed">
      <div class="embed__head">
        <p class="small"><strong>${title}</strong></p>
        <a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Open chart</a>
      </div>
      <div class="iframeWrap">
        <iframe src="${url}" loading="lazy" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  `;
}

function renderCards(stations) {
  const cardsEl = document.getElementById("cards");
  cardsEl.innerHTML = stations.map(st => {
    const [lat, lon] = st.coords;

    const sensorTabs = st.sensors.map(sensor => {
      const charts = st.charts?.[sensor] || {};
      const label = sensor === "bottom" ? "Bottom sensor" : "Top sensor";

      return `
        <div class="embeds">
          ${makeEmbedBlock(`${st.name} – ${label} – Turbidity`, charts.turbidity)}
          ${makeEmbedBlock(`${st.name} – ${label} – TSS`, charts.tss)}
          ${makeEmbedBlock(`${st.name} – ${label} – Dissolved Oxygen`, charts.do)}
          ${makeEmbedBlock(`${st.name} – ${label} – pH`, charts.ph)}
          ${makeEmbedBlock(`${st.name} – ${label} – Temperature`, charts.temp)}
        </div>
      `;
    }).join("");

    return `
      <article id="station-${st.id}" class="card">
        <div class="card__top">
          <div>
            <p class="card__title">${st.name} <span class="small subtle">(${st.id})</span></p>
            <p class="small subtle">Coordinates: ${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
            <p class="small subtle">Last sample: ${st.lastSampleText || "Shown in chart headers"}</p>
          </div>
          <div>${statusBadge(st.status)}</div>
        </div>

        <div class="actions">
          <a class="btn" href="#top">Back to top</a>
        </div>

        ${sensorTabs}
      </article>
    `;
  }).join("");
}

function initMap(stations) {
  const map = L.map("map", { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const bounds = [];

  stations.forEach(st => {
    const [lat, lon] = st.coords;
    bounds.push([lat, lon]);

    const marker = L.marker([lat, lon]).addTo(map);
    marker.bindPopup(`
      <strong>${st.name}</strong><br/>
      ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>
      Status: ${st.status || "Compliant"}<br/>
      <a href="#station-${st.id}">Jump to station</a>
    `);

    marker.on("click", () => {
      // optional: scroll to station when marker clicked
      setTimeout(() => {
        const el = document.getElementById(`station-${st.id}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    });
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
  return map;
}

(async function main() {
  try {
    const data = await loadStations();
    const stations = data.stations || [];
    renderCards(stations);
    initMap(stations);
  } catch (err) {
    console.error(err);
    document.getElementById("cards").innerHTML =
      `<div class="small subtle">Failed to load configuration. Check stations.json exists and is valid JSON.</div>`;
  }
})();
