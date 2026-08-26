// Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
// See LICENSE in the repository root -- source reuse is restricted to LEI.

// Simple CSV parser: returns array of objects with header keys
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] !== undefined ? cols[i].trim() : "";
    });
    return obj;
  });
}

// rasters/grpk/ (8.46 GB, ~8,800 files) is deliberately NOT part of this
// repo -- see the README's "Data not included" section -- so it's hosted
// on a Cloudflare R2 bucket instead (see grpk-hosting/README.md at the
// repo root) and every rasters/grpk/... reference needs to resolve there
// rather than same-origin. The bucket's contents ARE rasters/grpk/'s
// contents directly (rclone synced rasters/grpk/* to the bucket root), so
// this is just the bucket's public base URL, no /rasters/grpk/ suffix.
const GRPK_RASTER_BASE_URL = "https://pub-cd7bea89b7534c9884ac9c5f5610098e.r2.dev/";

/**
 * Resolve repo-root files (outputs/, rasters/, lt_subbasins.json) when the page is served from
 * .../dashboard/ — avoids broken relative URLs on GitHub Pages if the pathname omits a trailing slash.
 * rasters/grpk/... is special-cased to GRPK_RASTER_BASE_URL (see its own comment) since that one
 * dataset lives on external storage, not same-origin with the rest of the site.
 */
function resolveDataFileUrl(relFromRepoRoot) {
  const clean = String(relFromRepoRoot || "").replace(/^\/+/, "");
  const GRPK_PREFIX = "rasters/grpk/";
  if (clean.startsWith(GRPK_PREFIX)) {
    return GRPK_RASTER_BASE_URL + clean.slice(GRPK_PREFIX.length);
  }
  if (window.location.protocol === "file:") {
    try {
      return new URL(`../${clean}`, window.location.href).href;
    } catch {
      return `../${clean}`;
    }
  }
  const pathname = window.location.pathname || "";
  const parts = pathname.split("/").filter(Boolean);
  const dIdx = parts.indexOf("dashboard");
  if (dIdx < 0) {
    try {
      return new URL(`../${clean}`, window.location.href).href;
    } catch {
      return `../${clean}`;
    }
  }
  const rootParts = parts.slice(0, dIdx);
  const basePath = rootParts.length ? `/${rootParts.join("/")}` : "";
  const origin = window.location.origin || "";
  return `${origin}${basePath}/${clean}`;
}

/** Drop "baseinas" / "pabaseinis" wording from hydrology labels (map + list). */
function sanitizeBasinDisplayName(raw) {
  if (raw == null) return raw;
  let s = String(raw).trim();
  s = s.replace(/\s*\(?\s*baseinas\s*\)?/gi, "");
  s = s.replace(/\bbaseinas\b/gi, "");
  s = s.replace(/\s*\(?\s*pabaseinio\b/gi, "");
  s = s.replace(/\bpabaseinis\b/gi, "");
  s = s.replace(/\bpabaseinių\b/gi, "");
  s = s.replace(/\bpabaseiniai\b/gi, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || String(raw).trim();
}

/** api.meteo.lt's station names are the Lithuanian place name (kept as-is,
 * e.g. "Kudirkos Naumiesčio") plus the Lithuanian abbreviation "VMS"
 * (Vandens matavimo stotis, "water measurement station") -- half-Lithuanian
 * half-English mid-sentence on an otherwise-English dashboard. Translates
 * just that suffix to the standard English hydrology term, leaving the
 * place name untouched. Applied once at data-load time (loadHydroStations,
 * loadBasinHydrologyData) so every downstream render -- map tooltips, the
 * "jump to station" dropdown, hydrology card subtitles, aria-labels --
 * picks it up automatically without each needing its own translation. */
function translateStationName(name) {
  if (name == null) return name;
  return String(name).replace(/\s+VMS\b/, " gauging station");
}

function fitMapToBounds(map, bounds, options) {
  if (!map || !bounds || !bounds.isValid()) return;
  const size = map.getSize();
  const minSide = Math.max(1, Math.min(size.x, size.y));
  const pad = Math.max(12, Math.min(40, Math.round(minSide * 0.05)));
  map.fitBounds(bounds, {
    padding: [pad, pad],
    animate: false,
    maxZoom: 18,
    ...options,
  });
}

/** Lithuania overview — same bounds as initial map view. */
const LT_OVERVIEW_BOUNDS = L.latLngBounds([53.5, 20.5], [56.6, 26.85]);

const BASIN_STYLE_DEFAULT = {
  className: "basin-outline-path",
  color: "#64748b",
  weight: 1.25,
  fill: true,
  fillColor: "#64748b",
  fillOpacity: 0.02,
};

const BASIN_STYLE_SELECTED = {
  className: "basin-outline-path basin-outline-selected",
  color: "#c2410c",
  weight: 4,
  fill: true,
  fillColor: "#ea580c",
  fillOpacity: 0.12,
};

const BASIN_STYLE_DEFAULT_SAT = {
  className: "basin-outline-path",
  color: "#ffffff",
  weight: 1.75,
  fill: true,
  fillColor: "#ffffff",
  fillOpacity: 0.05,
};

const BASIN_STYLE_SELECTED_SAT = {
  className: "basin-outline-path basin-outline-selected",
  color: "#fbbf24",
  weight: 4,
  fill: true,
  fillColor: "#fbbf24",
  fillOpacity: 0.15,
};

function basinFeatureStyle(feature, geojsonRef) {
  const idx = geojsonRef.features.indexOf(feature);
  const sel = state.map.selectedBasinIndices;
  const selected = Array.isArray(sel) && sel.includes(idx);
  const sat = state.map.opts.baseMap === "satellite";
  if (selected) return { ...(sat ? BASIN_STYLE_SELECTED_SAT : BASIN_STYLE_SELECTED) };
  return { ...(sat ? BASIN_STYLE_DEFAULT_SAT : BASIN_STYLE_DEFAULT) };
}

function applyBasinOutlineHighlight(indices) {
  state.map.selectedBasinIndices = Array.isArray(indices) && indices.length ? indices : null;
  const layer = state.map.basinLayer;
  const gj = state.map.subbasins;
  if (!layer || typeof layer.setStyle !== "function" || !gj) return;
  layer.setStyle((feature) => basinFeatureStyle(feature, gj));
}

function getCsvYearsSorted(datasetKey) {
  const y = state.yearsByDataset[datasetKey] || [];
  return [...new Set(y.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}

/** CORINE CLC snapshots only exist from 1990 onward in this project. */
const CORINE_MIN_MAP_YEAR = 1990;

// ── Dataset registry — single source of truth for metadata & scalability ──────
// To add a new dataset: add an entry here, then add the CSV/raster paths in
// loadData(), getGeotiffUrl(), and RASTER_YEAR_CHECK_URLS. Update the HTML
// <select> and state initialisation to match.
const DATASET_REGISTRY = {
  hildaknn: {
    label: "HILDA+ With KNN",
    source: "Wageningen University & Research — reclassified with no unclassified pixels",
    temporal: "1960–2019 (annual)",
    resolution: "~1 km (1/12°)",
    renderResolution: 128, // ~1 km native
    description: "Global annual land use/cover reconstruction combining remote sensing, agricultural statistics, and historical surveys, with every raw state code assigned to a class: 'forest, unknown subtype' and unmanaged grass/shrubland are folded into Forest, and sparse/no-vegetation pixels are filled from the nearest already-classified HILDA pixel (1-nearest-neighbor) instead of left blank.",
    notes: [
      "Including the 'forest, unknown subtype' code pushes Forest share above what export_hilda_lithuania.py calibrates for against Lithuania's national forest inventory (~33%): 2020 Forest share is ~49.5% here vs ~32.9% in standard HILDA+.",
      "Genuine no-data pixels (satellite/temporal gaps) are still left unclassified — only sparse/no-vegetation is nearest-neighbor filled.",
    ],
    isValidation: false,
  },
  lucas: {
    label: "LUCAS LUC",
    source: "Eurostat / Joint Research Centre (JRC)",
    temporal: "2006, 2009, 2012, 2015, 2018",
    resolution: "Point survey (LUCAS sample grid)",
    renderResolution: 64, // point survey interpolated to coarse grid
    description: "EU field-based Land Use/Cover Area frame Survey, harmonised to the 5-class system for Lithuania.",
    notes: [
      "Sparse survey points — interpolated shares may differ from raster-based datasets.",
      "Some records lack a numeric class_id; classification is derived from class_name.",
    ],
    isValidation: false,
  },
  hyde: {
    label: "HYDE 3.4",
    source: "PBL Netherlands Environmental Assessment Agency",
    temporal: "10 000 BCE–2023 (decadal/annual)",
    resolution: "~10 km (5 arcmin)",
    renderResolution: 64, // ~10 km native
    description: "History Database of the Global Environment — long-term human land-use reconstruction from agricultural census data, historical records, and modelling.",
    notes: ["'Natural (residual)' covers all non-managed land (forest, shrubland, grassland combined) — not forest alone."],
    isValidation: false,
  },
  luh2: {
    label: "LUH2 v2h",
    source: "University of Maryland / NCAR (CMIP6)",
    temporal: "850–2015 (annual)",
    resolution: "~25 km (0.25°)",
    renderResolution: 64, // ~25 km native
    description: "Land Use Harmonization 2 — harmonised land-use forcing dataset developed for CMIP6 climate model simulations.",
    notes: ["Very coarse spatial resolution (~25 km); national totals are reliable but sub-basin detail is limited."],
    isValidation: false,
  },
  corine: {
    label: "CORINE CLC",
    source: "European Environment Agency (EEA) / Copernicus",
    temporal: "1990, 2000, 2006, 2012, 2018",
    resolution: "100 m",
    renderResolution: 128, // 100 m native
    description: "European reference land cover dataset produced by photo-interpretation of satellite imagery. Used as the primary validation reference in this dashboard.",
    notes: [
      "Validation reference only — not compared against itself in the RMSE metrics.",
      "Available from 1990 onwards in this project.",
    ],
    isValidation: true,
  },
  esri: {
    label: "Esri 10m Annual LULC",
    source: "Esri / Impact Observatory (Sentinel-2, deep learning classifier)",
    temporal: "2017–2025 (annual)",
    resolution: "10 m native — served as a real map-tile pyramid (same technique as a satellite basemap), so close-up zoom shows genuine 10 m detail instead of a resampled national grid. Tiles are pre-rendered up to zoom 12; deeper zoom just scales up the closest tile rather than resampling further.",
    // Lower than other datasets' 128 on purpose: this is a tiled dataset —
    // each on-screen tile only ever covers a small fraction of one grid
    // cell, so 128^2 samples/tile was oversampling relative to the actual
    // source detail while costing 4x the render time per tile (each tile
    // was taking 100-500ms, and a burst of these during rapid zooming was
    // saturating the main thread badly enough to blank the map).
    renderResolution: 32,
    description: "Our own Lithuania-wide mosaic built from Esri's 10m Annual Land Use Land Cover tiles, reclassified to the dashboard's 5-class scheme. National and sub-basin statistics are computed from the full 10m resolution data.",
    notes: [
      "Esri's Bare ground, Clouds, and Rangeland codes have no direct home in the 5-class scheme and are nearest-neighbor filled from the closest classified pixel.",
      "Used as a validation reference alongside CORINE and GRPK — other datasets are compared against it too.",
    ],
    isValidation: true,
  },
  grpk: {
    label: "GRPK PLOTAI (cadastre)",
    source: "Nacionalinė žemės tarnyba (NŽT) — Georeferencinis pagrindo kadastras",
    temporal: "Single snapshot (labelled with the latest plot edit date, not a real year)",
    resolution: "Vector cadastral plots — rendered as true vector polygons at close zoom (lossless, no resolution cap at all), the same parcel boundaries as the source data. At wider zoom, where drawing every parcel individually would be too slow, it falls back to a pre-rendered raster tile pyramid instead.",
    renderResolution: 32, // tiled dataset — see esri's renderResolution comment above
    description: "Lithuania's official cadastral plot boundaries (PLOTAI), reclassified from their GKODAS land-use code to the dashboard's 5-class scheme.",
    notes: [
      "This is a living, continuously-edited cadastre, not a dated observation — the single 'year' shown is just the most recent edit found in the source data.",
      "Some GKODAS prefixes (e.g. 'sd', 'gt') have no explicit rule in analysis/grpk_gkodas_mapping.json and fall back to the default class (Agriculture).",
      "Used as a validation reference alongside CORINE and Esri — see outputs/grpk_reference_shares.json for the precise area-weighted shares.",
    ],
    isValidation: true,
  },
};

/** Normalise legacy class name variants to the canonical 5-class names. */
function normalizeClassName(name) {
  if (name === "Wetlands") return "Wetland";
  return name;
}

/**
 * Display a brief toast notification instead of blocking alert().
 * type: "info" | "warning" | "error"
 */
function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  const duration = type === "error" ? 6000 : 4000;
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, duration);
}

/** Calendar years allowed on the map slider (CORINE clamped to valid CLC years). */
function getYearsForMapSlider(datasetKey) {
  const y = getCsvYearsSorted(datasetKey);
  if (datasetKey === "corine") {
    return y.filter((yr) => yr >= CORINE_MIN_MAP_YEAR);
  }
  return y;
}

/** Largest CSV / stats year ≤ calendarYear (same “floor” rule as the map raster). */
function pickDataYearForCalendarYear(calendarYear, datasetKey) {
  const ys = getYearsForMapSlider(datasetKey);
  return pickRasterYearForCalendarYear(calendarYear, ys);
}

function getRasterYearsSorted(datasetKey) {
  const r = state.rasterYearsByDataset[datasetKey];
  if (r !== null && Array.isArray(r) && r.length) return r.slice().sort((a, b) => a - b);
  return [];
}

/** Largest exported raster year ≤ calendarYear; if none, smallest available. */
function pickRasterYearForCalendarYear(calendarYear, rasterYearsSorted) {
  const ys = (rasterYearsSorted || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!ys.length) return NaN;
  if (calendarYear < ys[0]) return ys[0];
  let pick = ys[0];
  for (const y of ys) {
    if (y <= calendarYear) pick = y;
    else break;
  }
  return pick;
}

function formatMapYearLabel(calendarYear, rasterYear) {
  if (!Number.isFinite(calendarYear)) return "—";
  if (!Number.isFinite(rasterYear) || calendarYear === rasterYear) return String(calendarYear);
  return `${calendarYear} (nearest export: ${rasterYear})`;
}

/** Slider value = calendar year; returns { calendarYear, rasterYear } for map + zonal. */
function readYearSliderMapPair(datasetKey) {
  const yearSlider = document.getElementById("year-slider");
  const calendarYear = yearSlider ? Number(yearSlider.value) : NaN;
  if (!Number.isFinite(calendarYear)) return { calendarYear: NaN, rasterYear: NaN };
  const rasterYs = getRasterYearsSorted(datasetKey);
  let rasterYear = pickRasterYearForCalendarYear(calendarYear, rasterYs);
  if (!Number.isFinite(rasterYear)) {
    rasterYear = pickDataYearForCalendarYear(calendarYear, datasetKey);
  }
  if (!Number.isFinite(rasterYear)) rasterYear = calendarYear;
  return { calendarYear, rasterYear };
}

function getZonalYearsForBasin(index, basinIndex) {
  if (!(index instanceof Map) || !Number.isFinite(basinIndex)) return [];
  const ys = new Set();
  for (const key of index.keys()) {
    const [bi, y] = key.split("|").map(Number);
    if (bi === basinIndex && Number.isFinite(y)) ys.add(y);
  }
  return Array.from(ys).sort((a, b) => a - b);
}

/** Floor calendar year to latest zonal CSV year ≤ year; if none, same rule on raster years. */
function pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey) {
  const zonalYs = getZonalYearsForBasin(index, basinIndex);
  if (zonalYs.length) return pickRasterYearForCalendarYear(calendarYear, zonalYs);
  return pickRasterYearForCalendarYear(calendarYear, getRasterYearsSorted(datasetKey));
}

// ── Map appearance tile configs ───────────────────────────────────────────────
// CARTO retired anonymous access to these raster basemaps in 2026 -- an
// unauthenticated request still 200s but the tile is watermarked "API key
// required" (see carto.com/basemaps/apikey). The query param has to be
// literally "key", not "api_key" -- verified directly against the tile
// endpoint (api_key is silently ignored, the tile comes back byte-identical
// to an unauthenticated request; key= is what actually removes the
// watermark). Free tier: 5M tile requests/month.
const CARTO_API_KEY = "cb1_27kg_1_1c77ad7d981c7dded98558c0";
const TILE_CONFIGS = {
  street: {
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`,
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &amp; <a href='https://carto.com/attributions'>CARTO</a>",
    maxZoom: 19,
  },
  streetNoLabels: {
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`,
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &amp; <a href='https://carto.com/attributions'>CARTO</a>",
    maxZoom: 19,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    maxZoom: 18,
  },
  satelliteLabels: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution: "",
    maxZoom: 18,
  },
};

// Global state
const state = {
  hildaknn: null,
  lucas: null,
  hyde: null,
  luh2: null,
  corine: null,
  esri: null,
  grpk: null,
  yearsByDataset: {
    hildaknn: [],
    lucas: [],
    hyde: [],
    luh2: [],
    corine: [],
    esri: [],
    grpk: [],
  },
  rasterYearsByDataset: {
    hildaknn: null,
    lucas: null,
    hyde: null,
    luh2: null,
    corine: null,
    esri: null,
    grpk: null,
  },
  map: {
    instance: null,
    overlay: null,
    /** Active LayerGroup for tiled datasets (esri/grpk) — a separate slot from
     * `overlay` since a tier/viewport can require multiple simultaneous chunk
     * layers (raster tiles or, for GRPK's close tier, vector GeoJSON chunks). */
    tiledLayerGroup: null,
    /** { datasetKey, year, classIds, tier, cellsKey } for the currently-shown
     * tiled overlay, so the zoom/pan handler can tell whether anything
     * actually needs to change before re-fetching. */
    tiledActive: null,
    /** Esri's persistent pre-rendered XYZ tile layer (z4-12) — reused across
     * pans/zooms in that range instead of being torn down/rebuilt each time. */
    esriXyzLayer: null,
    /** GRPK's persistent pre-rendered XYZ tile layer (national/regional,
     * z4-11) — same pattern as esriXyzLayer above. */
    grpkXyzLayer: null,
    basinLayer: null,
    subbasins: null,
    basinsConfig: null,
    selectedBasinIndices: null,
    maskCleanup: null,
    baseTileLayer: null,
    labelTileLayer: null,
    scaleControl: null,
    searchMarker: null,
    /** LayerGroup of hydrological station markers, toggled via the
     * "Hydrological stations" map-options checkbox. */
    hydroStationsLayer: null,
    /** Markers parallel to state.hydroStations, so the "jump to station"
     * dropdown can open the right marker's popup after panning to it. */
    hydroStationMarkers: [],
    /** True while the map is showing the basin-hydrology view (dimmed
     * land-cover + main rivers + highlighted analysis stations) — entered
     * only via the sidebar's Charts/Hydrology switch, see setupDashboardsTabs. */
    hydrologyMapMode: false,
    hydrologyRiversLayer: null,
    opts: {
      baseMap: "street",
      showLabels: true,
      showBasins: true,
      showBasinLabels: true,
      showRaster: true,
      showScale: true,
      showHydroStations: false,
    },
  },
  charts: {
    trend: null,
    distribution: null,
  },
  /** Hydrological (water-gauging) station list loaded from hydro_stations.json — [{name, lat, lon}] */
  hydroStations: [],
  /** Station results pinned to the sidebar's Hydrology tab via a popup's "+
   * Sidebar" button — [{id, code, name, waterBody, from, to, obs, pinnedAt}],
   * persisted to localStorage (see loadHydroPinsFromStorage). */
  pinnedHydroStations: [],
  /** Pre-computed sub-basin zonal CSV: datasetKey → Map("basin|year" → { counts, total }) | false if missing */
  subbasinZonal: {},
  /** datasetKey → Promise while CSV is loading */
  subbasinZonalLoading: {},
  /** Latest fetch of outputs/dashboard_validation_metrics.json (for reference switcher) */
  validationMetrics: null,
  /** Parsed georasters keyed by "dataset|year" — avoids re-downloading on class filter changes */
  georasterCache: new Map(),
  /** Parsed georasters for tiled datasets (esri/grpk), keyed by tile URL */
  tileGeorasterCache: new Map(),
  /** Cached tiles/manifest.json per tiled dataset (esri, grpk) */
  tileManifests: {},
};

let applyFiltersSeq = 0;

function getSelectedClassNames() {
  const allCb = document.getElementById("class-all");
  if (!allCb || allCb.checked) return CANONICAL_CLASSES.slice();
  return Array.from(document.querySelectorAll(".class-cb:checked")).map((cb) => cb.value);
}

function getSelectedBasinIndices() {
  const allCb = document.getElementById("basin-all");
  if (!allCb || allCb.checked) return null; // null = national / All Lithuania
  const checked = Array.from(document.querySelectorAll(".basin-cb:checked"));
  return checked.map((cb) => parseInt(cb.value, 10)).filter(Number.isFinite);
}

function updateMsToggleLabel(toggleId, masterCbId, itemClass, allLabel) {
  const toggle = document.getElementById(toggleId);
  const masterCb = document.getElementById(masterCbId);
  if (!toggle) return;
  const labelEl = toggle.querySelector(".ms-toggle-label");
  if (!labelEl) return;
  const items = document.querySelectorAll(`.${itemClass}`);
  const checked = Array.from(items).filter((cb) => cb.checked);
  if (!items.length || checked.length === items.length || masterCb?.checked) {
    labelEl.textContent = allLabel;
  } else if (checked.length === 0) {
    labelEl.textContent = "None selected";
  } else if (checked.length === 1) {
    const txt = checked[0].closest(".ms-item")?.querySelector("span:last-child")?.textContent?.trim();
    labelEl.textContent = txt || "1 selected";
  } else {
    labelEl.textContent = `${checked.length} selected`;
  }
}

/** Matches GeoTIFF class codes (same as Python export) */
const CLASS_ID_TO_NAME = {
  1: "Water",
  2: "Wetland",
  3: "Urban",
  4: "Agriculture",
  5: "Forest",
};
const NAME_TO_CLASS_ID = {
  Water: 1,
  Wetland: 2,
  Urban: 3,
  Agriculture: 4,
  Forest: 5,
  "Natural (residual)": 5,
};

function buildSubbasinZonalIndex(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.year) || !Number.isFinite(r.basin_index)) continue;
    const key = `${r.basin_index}|${r.year}`;
    let cell = m.get(key);
    if (!cell) {
      cell = { counts: {}, total: null }; // null = no explicit total yet
      m.set(key, cell);
    }
    const id = Math.round(Number(r.class_id));
    const c = Number.isFinite(r.count) ? r.count : 0;
    if (id === 0) {
      cell.total = c; // explicit total (all pixels within polygon, incl. unclassified)
    } else if (id >= 1 && id <= 5) {
      cell.counts[id] = (cell.counts[id] || 0) + c;
    }
  }
  // For old CSVs without class_id=0, fall back to sum of classified pixels
  for (const [, cell] of m) {
    if (cell.total === null) {
      cell.total = [1, 2, 3, 4, 5].reduce((s, id) => s + (cell.counts[id] || 0), 0);
    }
  }
  return m;
}

async function ensureSubbasinZonalLoaded(datasetKey) {
  const cached = state.subbasinZonal[datasetKey];
  if (cached instanceof Map) return true;
  if (cached === false) return false;

  if (state.subbasinZonalLoading[datasetKey]) {
    await state.subbasinZonalLoading[datasetKey];
    return state.subbasinZonal[datasetKey] instanceof Map;
  }

  const p = (async () => {
    try {
      const url = resolveDataFileUrl(`outputs/subbasin_zonal_${datasetKey}.csv`);
      const resp = await fetch(url);
      if (!resp.ok) {
        logMissingData(`${datasetKey} sub-basin zonal CSV`, url, resp);
        state.subbasinZonal[datasetKey] = false;
        return;
      }
      const text = await resp.text();
      const raw = parseCsv(text);
      const rows = raw.map((row) => ({
        year: Number(row.year),
        basin_index: Number(row.basin_index),
        class_id: Number(row.class_id),
        count: Number(row.count),
      }));
      state.subbasinZonal[datasetKey] = buildSubbasinZonalIndex(rows);
    } catch (e) {
      console.warn("Sub-basin zonal CSV load failed", e);
      state.subbasinZonal[datasetKey] = false;
    } finally {
      delete state.subbasinZonalLoading[datasetKey];
    }
  })();

  state.subbasinZonalLoading[datasetKey] = p;
  await p;
  return state.subbasinZonal[datasetKey] instanceof Map;
}

function buildSubbasinTrendPayload(
  index,
  basinIndices,
  selectedClasses,
  fromYear,
  toYear,
  availableYears,
  datasetKey,
) {
  const classNamesOrdered = nationalDistributionClassLabels(datasetKey);
  const yearsFiltered = availableYears.filter((y) => {
    if (Number.isFinite(fromYear) && y < fromYear) return false;
    if (Number.isFinite(toYear) && y > toYear) return false;
    return true;
  });
  const labels = yearsFiltered.slice();
  const pickNames =
    selectedClasses && selectedClasses.length < classNamesOrdered.length
      ? classNamesOrdered.filter((c) => selectedClasses.includes(c))
      : classNamesOrdered;

  const series = pickNames.map((cls) => {
    const idNum = NAME_TO_CLASS_ID[cls];
    return {
      label: cls,
      data: labels.map((y) => {
        let totalCnt = 0;
        let totalAll = 0;
        basinIndices.forEach((bi) => {
          const cell = index.get(`${bi}|${y}`);
          if (cell && cell.total > 0) {
            totalCnt += cell.counts[idNum] || 0;
            totalAll += cell.total;
          }
        });
        return totalAll > 0 && idNum ? (totalCnt / totalAll) * 100 : 0;
      }),
    };
  });

  return {
    labels,
    series,
    yLabel: "% of basin cells (Python zonal)",
  };
}

function buildSubbasinDistPayload(index, basinIndices, mapYear, datasetKey) {
  if (!Number.isFinite(mapYear)) return { labels: [], values: [] };
  const classLabels = nationalDistributionClassLabels(datasetKey);
  const totals = {};
  let grandTotal = 0;
  basinIndices.forEach((bi) => {
    const cell = index.get(`${bi}|${mapYear}`);
    if (cell && cell.total > 0) {
      grandTotal += cell.total;
      classLabels.forEach((_, i) => {
        const id = i + 1;
        totals[id] = (totals[id] || 0) + (cell.counts[id] || 0);
      });
    }
  });
  if (grandTotal <= 0) return { labels: [], values: [] };
  return {
    labels: classLabels.slice(),
    values: classLabels.map((_, i) => ((totals[i + 1] || 0) / grandTotal) * 100),
  };
}

/** National shares for one map year; percentages sum to 100% over classified cells. */
function buildNationalDistributionForYear(rows, mapYear, datasetKey = "hildaknn") {
  if (!rows?.length || !Number.isFinite(mapYear)) return { labels: [], values: [] };
  const byId = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows
    .filter((r) => r.year === mapYear)
    .forEach((r) => {
      let id = Number(r.class_id);
      if (!Number.isFinite(id) || id < 1 || id > 5) {
        const nm = normalizeClassName(r.class_name);
        id = NAME_TO_CLASS_ID[nm];
      }
      if (Number.isFinite(id) && id >= 1 && id <= 5) {
        byId[id] += r.count;
      }
    });
  const labels = nationalDistributionClassLabels(datasetKey);
  const total = labels.reduce((s, _, i) => s + byId[i + 1], 0);
  if (total <= 0) return { labels: [], values: [] };
  return {
    labels: labels.slice(),
    values: labels.map((_, i) => (byId[i + 1] / total) * 100),
  };
}

function distributionNonZeroSlices(labels, values) {
  const outL = [];
  const outV = [];
  labels.forEach((lb, i) => {
    const v = values[i];
    if (v > 0) {
      outL.push(lb);
      outV.push(v);
    }
  });
  return { labels: outL, values: outV };
}

/**
 * A 404/500 response resolves fetch() normally (no exception) — without this,
 * a missing CSV/GeoTIFF fails completely silently and just looks like "nothing loads".
 */
function logMissingData(label, url, resp) {
  console.warn(`[Data] ${label} not found (HTTP ${resp.status}): ${url}`);
}

async function loadData() {
  // Paths are relative to dashboard/ folder.
  // For simplicity, we serve CSVs from Data/outputs/, so that the
  // static HTTP server rooted at Data can see them.
  try {
    const hildaknnUrl = resolveDataFileUrl("outputs/hildaknn_lithuania_timeseries.csv");
    const hildaknnResp = await fetch(hildaknnUrl);
    if (hildaknnResp.ok) {
      const txt = await hildaknnResp.text();
      state.hildaknn = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.hildaknn = Array.from(new Set(state.hildaknn.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("HILDA+ With KNN CSV", hildaknnUrl, hildaknnResp);
    }
  } catch (e) {
    console.warn("Could not load HILDA+ With KNN CSV", e);
  }

  try {
    // Updated to use full LUCAS time-series CSV
    const lucasUrl = resolveDataFileUrl("outputs/lucas_lithuania_timeseries.csv");
    const lucasResp = await fetch(lucasUrl);
    if (lucasResp.ok) {
      const txt = await lucasResp.text();
      state.lucas = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: row.class_id !== undefined && row.class_id !== "" ? Number(row.class_id) : NaN,
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.lucas = Array.from(new Set(state.lucas.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("LUCAS CSV", lucasUrl, lucasResp);
    }
  } catch (e) {
    console.warn("Could not load LUCAS CSV", e);
  }

  try {
    const hydeUrl = resolveDataFileUrl("outputs/hyde_lithuania_timeseries.csv");
    const hydeResp = await fetch(hydeUrl);
    if (hydeResp.ok) {
      const txt = await hydeResp.text();
      state.hyde = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.hyde = Array.from(new Set(state.hyde.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("HYDE CSV", hydeUrl, hydeResp);
    }
  } catch (e) {
    console.warn("Could not load HYDE CSV", e);
  }

  try {
    const luh2Url = resolveDataFileUrl("outputs/luh2_lithuania_timeseries.csv");
    const luh2Resp = await fetch(luh2Url);
    if (luh2Resp.ok) {
      const txt = await luh2Resp.text();
      state.luh2 = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.luh2 = Array.from(new Set(state.luh2.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("LUH2 CSV", luh2Url, luh2Resp);
    }
  } catch (e) {
    console.warn("Could not load LUH2 CSV", e);
  }

  try {
    const corUrl = resolveDataFileUrl("outputs/corine_lithuania_timeseries.csv");
    const corResp = await fetch(corUrl);
    if (corResp.ok) {
      const txt = await corResp.text();
      state.corine = parseCsv(txt)
        .map((row) => ({
          year: Number(row.year),
          class_name: row.class_name,
          count: Number(row.count),
        }))
        .filter((r) => Number.isFinite(r.year) && r.year >= CORINE_MIN_MAP_YEAR);
      state.yearsByDataset.corine = Array.from(new Set(state.corine.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("CORINE CSV", corUrl, corResp);
    }
  } catch (e) {
    console.warn("Could not load CORINE CSV", e);
  }

  try {
    const esriUrl = resolveDataFileUrl("outputs/esri_lithuania_timeseries.csv");
    const esriResp = await fetch(esriUrl);
    if (esriResp.ok) {
      const txt = await esriResp.text();
      state.esri = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.esri = Array.from(new Set(state.esri.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("Esri CSV", esriUrl, esriResp);
    }
  } catch (e) {
    console.warn("Could not load Esri CSV", e);
  }

  try {
    const grpkUrl = resolveDataFileUrl("outputs/grpk_lithuania_timeseries.csv");
    const grpkResp = await fetch(grpkUrl);
    if (grpkResp.ok) {
      const txt = await grpkResp.text();
      state.grpk = parseCsv(txt).map((row) => ({
        year: Number(row.year),
        class_id: Number(row.class_id),
        class_name: row.class_name,
        count: Number(row.count),
      }));
      state.yearsByDataset.grpk = Array.from(new Set(state.grpk.map((r) => r.year)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } else {
      logMissingData("GRPK CSV", grpkUrl, grpkResp);
    }
  } catch (e) {
    console.warn("Could not load GRPK CSV", e);
  }
}

function initMap(savedState) {
  const map = L.map("map", {
    zoomControl: false, // added manually below, repositioned to match the floating bottom-right cluster
    // No maxBounds: the map is the full-viewport background now, and the "Find location" search
    // can jump anywhere — locking pan/zoom to Lithuania's box would fight both of those.
    minZoom: 3,
    /** Canvas paths align with raster/tiles in screenshots; SVG + html2canvas often shifts outlines */
    preferCanvas: true,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // "Recenter" — since the map can now pan/zoom anywhere (no maxBounds), this is the
  // way back to the default Lithuania overview. Implemented as a real Leaflet control
  // so it auto-stacks with the zoom buttons instead of needing its own offset math.
  const RecenterControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const btn = L.DomUtil.create("a", "leaflet-control-recenter");
      btn.href = "#";
      btn.title = "Recenter on Lithuania";
      btn.setAttribute("aria-label", "Recenter on Lithuania");
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.preventDefault(e);
        map.fitBounds(LT_OVERVIEW_BOUNDS, { padding: [12, 12] });
      });
      return btn;
    },
  });
  new RecenterControl().addTo(map);

  if (savedState?.mapLat != null && savedState?.mapZoom != null) {
    map.setView([savedState.mapLat, savedState.mapLng], savedState.mapZoom);
  } else {
    map.fitBounds(LT_OVERVIEW_BOUNDS, { padding: [12, 12] });
  }

  map.createPane("rasterPane");
  map.getPane("rasterPane").style.zIndex = "350";
  map.getPane("rasterPane").style.pointerEvents = "none";

  map.createPane("basinOutlinePane");
  map.getPane("basinOutlinePane").style.zIndex = "450";

  // Between basinOutlinePane and hydroStationPane: the basin-hydrology main
  // rivers (hydrology map mode) sit above the dimmed land-cover raster and
  // basin outlines, but below the station markers so markers stay clickable.
  map.createPane("hydrologyRiversPane");
  map.getPane("hydrologyRiversPane").style.zIndex = "455";

  // Above basinOutlinePane so its (often whole-country-covering, interactive)
  // subbasin fill polygons don't intercept hover/click on station markers
  // underneath — without this, hovering/clicking a marker anywhere the basin
  // layer covers silently did nothing.
  map.createPane("hydroStationPane");
  map.getPane("hydroStationPane").style.zIndex = "460";

  // Performance logging: measure time between zoomstart and zoomend.
  let _zoomStart = 0;
  map.on("zoomstart", () => { _zoomStart = performance.now(); });
  map.on("zoomend", () => {
    const ms = (performance.now() - _zoomStart).toFixed(1);
    console.log(`[Map] zoom → level ${map.getZoom()} (${ms} ms)`);
  });

  const streetCfg = TILE_CONFIGS.street;
  state.map.baseTileLayer = L.tileLayer(streetCfg.url, {
    maxZoom: streetCfg.maxZoom,
    attribution: streetCfg.attribution,
  }).addTo(map);
  state.map.labelTileLayer = null;
  state.map.scaleControl = L.control.scale({ position: "bottomleft", metric: true, imperial: false }).addTo(map);

  // Load basin config and sub-basins, then draw
  Promise.all([
    fetch("basins-config.json").then((r) => (r.ok ? r.json() : null)),
    fetch(resolveDataFileUrl("lt_subbasins.json")).then((r) => (r.ok ? r.json() : null)),
  ]).then(([config, geojson]) => {
    if (!geojson) return;
    state.map.subbasins = geojson;
    state.map.basinsConfig = config;

    function getBasinName(feature, index) {
      const oid = String(feature.properties?.OBJECTID ?? index);
      const fromConfig = config?.namesByObjectId?.[oid];
      let label;
      if (fromConfig) label = fromConfig;
      else {
        const raw = feature.properties?.PAVADINIMA || feature.properties?.pavadinima || "";
        label = raw && raw !== "-" ? raw : `Basin polygon ${index + 1}`;
      }
      return sanitizeBasinDisplayName(label);
    }

    // Populate basin checkbox panel
    const basinPanel = document.getElementById("basin-ms-panel");
    const entries = geojson.features.map((f, i) => ({ idx: i, name: getBasinName(f, i) }));
    const orderList = config?.displayOrderByObjectId;
    const rank =
      Array.isArray(orderList) && orderList.length
        ? new Map(orderList.map((id, i) => [String(id), i]))
        : null;
    entries.sort((a, b) => {
      if (rank) {
        const oa = String(geojson.features[a.idx]?.properties?.OBJECTID ?? "");
        const ob = String(geojson.features[b.idx]?.properties?.OBJECTID ?? "");
        const ra = rank.has(oa) ? rank.get(oa) : 9999;
        const rb = rank.has(ob) ? rank.get(ob) : 9999;
        if (ra !== rb) return ra - rb;
      }
      return a.name.localeCompare(b.name, "lt", { sensitivity: "base" });
    });
    if (basinPanel) {
      entries.forEach(({ idx, name }) => {
        const lbl = document.createElement("label");
        lbl.className = "ms-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "basin-cb";
        cb.value = String(idx);
        cb.checked = true;
        cb.dataset.basinName = name;
        const span = document.createElement("span");
        span.textContent = name;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        basinPanel.appendChild(lbl);
      });
    }

    const layer = L.geoJSON(geojson, {
      pane: "basinOutlinePane",
      interactive: true,
      style: (feature) => basinFeatureStyle(feature, geojson),
      onEachFeature: (feature, leafletLayer) => {
        const idx = geojson.features.indexOf(feature);
        leafletLayer._basinIndex = idx;
        leafletLayer.feature = feature;
        const name = getBasinName(feature, idx);
        const oid = feature.properties?.OBJECTID;
        leafletLayer.bindTooltip(name, {
          permanent: true,
          direction: "center",
          offset: oid === 673 ? L.point(110, -8) : L.point(0, 0),
          className: "basin-label",
          interactive: false,
        });
      },
    }).addTo(map);
    state.map.basinLayer = layer;
    state.map.selectedBasinIndex = null;

    // Restore basin selection from a dataset-switch reload snapshot.
    if (Array.isArray(savedState?.selectedBasins) && savedState.selectedBasins.length > 0) {
      const selSet  = new Set(savedState.selectedBasins);
      const allCb   = document.getElementById("basin-all");
      const items   = document.querySelectorAll(".basin-cb");
      items.forEach((cb) => { cb.checked = selSet.has(parseInt(cb.value, 10)); });
      const n = savedState.selectedBasins.length;
      if (allCb) {
        allCb.checked       = n === items.length;
        allCb.indeterminate = n > 0 && n < items.length;
      }
      updateMsToggleLabel("basin-ms-toggle", "basin-all", "basin-cb", "All Lithuania");
      applyBasinOutlineHighlight(savedState.selectedBasins);
    } else {
      applyBasinOutlineHighlight(null);
    }

    // Only fit to Lithuania on first load; skip if a saved view will be applied.
    if (!savedState?.mapLat) fitMapToBounds(map, layer.getBounds());
  }).catch((e) => {
    console.warn("Could not load basins config or lt_subbasins.json", e);
  });

  state.map.instance = map;
  setupMapExport();
  setupBasinZoom();
  loadHydroStations(map);
}

// api.meteo.lt (the Lithuanian Hydrometeorological Service's own public API
// for these stations' actual readings) sends no Access-Control-Allow-Origin
// header, so the browser blocks a direct fetch() to it from this page's
// origin no matter where this page itself is hosted. Locally,
// serve_dashboard.py (replaces the plain `python -m http.server`) proxies
// it same-origin at /api/hydro/ — see that file for why. That's Python,
// though, and GitHub Pages (or any other purely static host) can't run it
// — so a deploy there instead goes through a small always-on Cloudflare
// Worker that does the identical proxying job; see
// cloudflare-worker/README.md for how to deploy your own and what URL to
// put below. Swap WORKER_HYDRO_PROXY_URL for that URL once you have one —
// until then, a non-localhost deploy will have every hydro-data feature
// fail (same as before this Worker existed, just no longer silent: see
// fetchHydroDay's failed/502 handling).
const WORKER_HYDRO_PROXY_URL = "https://lithuania-dashboard-hydro-proxy.gustas-gozelskis.workers.dev/api/hydro/";
// Covers not just localhost but a LAN IP too (e.g. testing from a phone on
// the same WiFi as the machine running serve_dashboard.py) -- GitHub Pages
// URLs are never in these ranges, so this only ever picks the local proxy
// when serve_dashboard.py is actually the thing serving the page.
function isLocalDevHost(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
}
const HYDRO_API_PROXY = isLocalDevHost(window.location.hostname) ? "/api/hydro/" : WORKER_HYDRO_PROXY_URL;
// The API only returns one day at a time (no native date-range endpoint —
// confirmed by probing it directly), so a multi-day view means one request
// per day. These caps keep that bounded to a handful of seconds even though
// the browser serializes same-origin requests past ~6 in flight.
const HYDRO_MEASURED_MAX_DAYS = 14;
const HYDRO_MARKER_RADIUS = 8;
const HYDRO_MARKER_RADIUS_HOVER = 14;
const HYDRO_MARKER_RADIUS_ANALYSIS = 11;
const HYDRO_MARKER_FILL_DEFAULT = "#16a34a";
const HYDRO_MARKER_STROKE_DEFAULT = "#14532d";
const HYDRO_MARKER_FILL_ANALYSIS = "#f59e0b";
const HYDRO_MARKER_STROKE_ANALYSIS = "#b45309";

/** Triangular Leaflet divIcon for a hydrology station marker — circleMarker
 * can only render circles, so station markers use L.marker + this custom
 * SVG icon instead (a filled/stroked <polygon>, mirroring circleMarker's
 * own radius/color/fillColor/weight options so the existing hover-grow and
 * highlightAnalysisStations recoloring logic translates directly, see
 * setHydroMarkerStyle). `radius` is treated as a half-width, matching
 * circleMarker's own radius semantics, so existing size constants
 * (HYDRO_MARKER_RADIUS etc.) didn't need to change. */
function hydroStationTriangleIcon(radius, fillColor, strokeColor, strokeWidth) {
  const size = Math.round(radius * 2);
  const half = size / 2;
  const points = `${half},1 ${size - 1},${size - 1} 1,${size - 1}`;
  return L.divIcon({
    className: "hydro-station-triangle-icon",
    html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${points}" fill="${fillColor}" fill-opacity="0.85" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`,
    iconSize: [size, size],
    iconAnchor: [half, half],
  });
}

/** Applies a triangle marker's current radius/colors by rebuilding its icon
 * from the marker's own tracked style — the L.marker equivalent of
 * circleMarker's setRadius/setStyle, which L.marker doesn't have (its icon
 * is one opaque unit, not separately restylable via CSS-like properties).
 * Any option left out keeps its previous value, so a hover handler can pass
 * just `{ radius }` without clobbering the marker's current colors. */
function setHydroMarkerStyle(marker, { radius, fillColor, strokeColor, strokeWidth } = {}) {
  if (radius != null) marker._radius = radius;
  if (fillColor != null) marker._fillColor = fillColor;
  if (strokeColor != null) marker._strokeColor = strokeColor;
  if (strokeWidth != null) marker._strokeWidth = strokeWidth;
  marker.setIcon(hydroStationTriangleIcon(marker._radius, marker._fillColor, marker._strokeColor, marker._strokeWidth));
}

function hydroApiUrl(path) {
  return `${HYDRO_API_PROXY}${path}`;
}

/** Fetches one station-day of observations. A 404 (no data that day) is
 * expected and common, not an error worth surfacing per-day in a multi-day
 * range -- `failed` stays false for it. Anything else failing (a proxy/
 * upstream error from serve_dashboard.py's own hydro proxy -- e.g. a 502
 * when the server machine's own connection to api.meteo.lt is down/blocked
 * on whatever network it's on right now -- or a fetch()-level exception)
 * sets `failed: true` instead, so the caller can tell "genuinely no data"
 * apart from "couldn't reach the service" rather than showing the same
 * silent blank result for both. */
async function fetchHydroDay(code, type, date) {
  try {
    const resp = await fetch(hydroApiUrl(`hydro-stations/${code}/observations/${type}/${date}`));
    if (resp.status === 404) return { observations: [], failed: false };
    if (!resp.ok) return { observations: [], failed: true };
    const data = await resp.json();
    return { observations: data.observations || [], failed: false };
  } catch (e) {
    console.warn("[hydro] fetch failed", type, date, e);
    return { observations: [], failed: true };
  }
}

/** Inclusive list of YYYY-MM-DD dates from `fromStr` to `toStr`, capped to
 * the most recent `maxDays` of the range (trimming from the older end) so a
 * too-wide range doesn't balloon into hundreds of requests. */
function hydroDateRange(fromStr, toStr, maxDays) {
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
  const out = [];
  const d = new Date(from);
  while (d <= to) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out.length > maxDays ? out.slice(-maxDays) : out;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Builds the interactive popup body for one station: a date picker + Load
 * button for that day's hourly readings, filled in lazily once the popup
 * actually opens (see wireHydroPopup) rather than pre-fetched for all 97
 * stations up front. Recent (hourly) data only — the full Historical archive
 * view lives in the Hydrology tab, not this small in-map popup. */
function buildHydroPopupHtml(st) {
  const today = todayIso();
  const defaultFrom = isoDaysAgo(6);
  // api.meteo.lt's "measured" endpoint (used here) is a rolling live-telemetry
  // feed, NOT a historical archive -- confirmed by probing it directly, it
  // 404s for every station past ~32 days back, always, regardless of which
  // station. The old 365-day min let users pick a date range that could
  // never return data no matter what they clicked, which looked exactly
  // like "this station's API is broken" (it wasn't -- all 97 stations work
  // fine within the actual window). 28 days keeps a safety margin inside the
  // real ~32-day cutoff. Anything older belongs in the Hydrology tab's own
  // Historical-archive-backed correlation view instead.
  const minDate = isoDaysAgo(28);
  const waterBody = st.waterBody ? `<div class="hydro-popup-subtitle">${st.waterBody}</div>` : "";
  return `
    <div class="hydro-popup">
      <div class="hydro-popup-title">${st.name}</div>
      ${waterBody}
      <div class="hydro-popup-controls">
        <div class="hydro-popup-daterow">
          <span class="hydro-popup-date-label">UTC:</span>
          <input type="date" class="hydro-popup-from" value="${defaultFrom}" min="${minDate}" max="${today}">
          <span class="hydro-popup-date-sep">→</span>
          <input type="date" class="hydro-popup-to" value="${today}" min="${minDate}" max="${today}">
          <button type="button" class="hydro-popup-load-btn">Load</button>
        </div>
        <div class="hydro-popup-actionrow">
          <button type="button" class="hydro-popup-expand-btn" title="Expand graph" disabled>Expand ⤢</button>
          <button type="button" class="hydro-popup-pin-btn" title="Save this to the sidebar" disabled>+ Sidebar</button>
        </div>
      </div>
      <div class="hydro-popup-notice-area"></div>
      <div class="hydro-popup-result">
        <p class="hydro-popup-status">Loading…</p>
        <div class="hydro-popup-chart-wrap" hidden><canvas class="hydro-popup-chart" role="img" aria-label="Water level and temperature chart"></canvas></div>
      </div>
    </div>
  `;
}

/** Builds the Chart.js config shared everywhere the same hourly water
 * level/temperature series gets drawn — the popup's inline canvas, the
 * expand modal's bigger one, and pinned sidebar cards — same data/series/
 * colors, just different sizing behavior (fixed pixel canvas vs. a
 * responsive fill of its wrapper). */
function hydroPopupChartConfig(obs, isMapPopup, tooltipPanelId) {
  return {
    type: "line",
    data: {
      labels: obs.map((o) => o.observationTimeUtc.slice(5, 16)),
      datasets: [
        {
          label: "Water level (cm)",
          data: obs.map((o) => o.waterLevel),
          borderColor: "#1572a6",
          backgroundColor: "#1572a6",
          yAxisID: "y",
          tension: 0.25,
          pointRadius: 0,
        },
        {
          label: "Water temp (°C)",
          data: obs.map((o) => o.waterTemperature),
          borderColor: "#e07b39",
          backgroundColor: "#e07b39",
          yAxisID: "y1",
          tension: 0.25,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { type: "linear", position: "left", title: { display: true, text: "cm" } },
        y1: { type: "linear", position: "right", title: { display: true, text: "°C" }, grid: { drawOnChartArea: false } },
        // 10px ticks are only tolerated inside the small map popup; every
        // other chart (modal, pins, hydrology sidebar) needs >=11.
        x: { ticks: { autoSkip: true, maxTicksLimit: isMapPopup ? 6 : 16, font: { size: isMapPopup ? 10 : 11 } } },
      },
      plugins: {
        legend: { display: true, labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: tooltipPanelId ? { enabled: false, external: hydroExternalTooltipHandler(tooltipPanelId) } : undefined,
      },
    },
  };
}

/** Fetches and renders one station's hourly readings for the selected date
 * range (one request per day, capped at HYDRO_MEASURED_MAX_DAYS) into its
 * own open popup. Keeps the fetched observations on chartHolder so the
 * Expand and "+ Sidebar" buttons can reuse them without a second fetch. */
async function loadHydroPopupObservations(st, fromStr, toStr, popupEl, chartHolder) {
  const statusEl = popupEl.querySelector(".hydro-popup-status");
  const chartWrap = popupEl.querySelector(".hydro-popup-chart-wrap");
  const canvas = popupEl.querySelector(".hydro-popup-chart");
  const expandBtn = popupEl.querySelector(".hydro-popup-expand-btn");
  const pinBtn = popupEl.querySelector(".hydro-popup-pin-btn");
  const noticeArea = popupEl.querySelector(".hydro-popup-notice-area");
  chartWrap.hidden = true;
  expandBtn.disabled = true;
  pinBtn.disabled = true;
  chartHolder.obs = null;
  if (chartHolder.chart) {
    chartHolder.chart.destroy();
    chartHolder.chart = null;
  }

  // Silently swap an inverted range rather than erroring — the user's intent
  // ("these two dates") is unambiguous either way.
  if (fromStr > toStr) {
    [fromStr, toStr] = [toStr, fromStr];
    const fromInput = popupEl.querySelector(".hydro-popup-from");
    const toInput = popupEl.querySelector(".hydro-popup-to");
    if (fromInput) fromInput.value = fromStr;
    if (toInput) toInput.value = toStr;
  }

  const fromD = new Date(`${fromStr}T00:00:00Z`);
  const toD = new Date(`${toStr}T00:00:00Z`);
  const rawSpanDays = Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())
    ? 0
    : Math.round((toD - fromD) / 86400000) + 1;

  const dates = hydroDateRange(fromStr, toStr, HYDRO_MEASURED_MAX_DAYS);
  if (!dates.length) {
    statusEl.hidden = false;
    statusEl.textContent = `Pick a valid date range (From on or before To, within ${HYDRO_MEASURED_MAX_DAYS} days).`;
    return;
  }
  if (rawSpanDays > HYDRO_MEASURED_MAX_DAYS) {
    showHydroNotice(`Showing the most recent ${HYDRO_MEASURED_MAX_DAYS} days of your selection.`, noticeArea);
  }
  statusEl.hidden = false;
  statusEl.textContent = "Loading…";

  const requestId = (chartHolder.requestId = (chartHolder.requestId || 0) + 1);
  const perDay = await Promise.all(dates.map((d) => fetchHydroDay(st.code, "measured", d)));
  if (requestId !== chartHolder.requestId) return; // superseded by a newer load
  const obs = perDay.flatMap((d) => d.observations);
  if (!obs.length) {
    statusEl.textContent = perDay.some((d) => d.failed)
      ? "Couldn't reach the water-data service (api.meteo.lt) — check your connection and try again."
      : "No data for this date range at this station.";
    return;
  }
  statusEl.hidden = true;
  chartWrap.hidden = false;
  chartHolder.obs = obs;
  chartHolder.from = fromStr;
  chartHolder.to = toStr;
  expandBtn.disabled = false;
  pinBtn.disabled = false;
  chartHolder.chart = new Chart(canvas.getContext("2d"), hydroPopupChartConfig(obs, true));
  canvas.setAttribute("aria-label", `Water level and temperature, ${st.name}, ${fromStr} to ${toStr}`);
}

/** Wires up a just-opened popup's controls. Popup content is inserted as an
 * HTML string (buildHydroPopupHtml), so listeners can only be attached once
 * that DOM actually exists — hence doing this in a popupopen handler rather
 * than at marker-creation time. */
function wireHydroPopup(marker, st) {
  const chartHolder = { chart: null, obs: null, from: null, to: null, requestId: 0 };
  marker.on("popupopen", () => {
    const popupEl = marker.getPopup().getElement();
    if (!popupEl || popupEl._hydroWired) return;
    popupEl._hydroWired = true;
    const fromInput = popupEl.querySelector(".hydro-popup-from");
    const toInput = popupEl.querySelector(".hydro-popup-to");
    const loadBtn = popupEl.querySelector(".hydro-popup-load-btn");
    const expandBtn = popupEl.querySelector(".hydro-popup-expand-btn");
    const pinBtn = popupEl.querySelector(".hydro-popup-pin-btn");
    loadBtn.addEventListener("click", () => {
      loadHydroPopupObservations(st, fromInput.value, toInput.value, popupEl, chartHolder);
    });
    expandBtn.addEventListener("click", () => {
      if (!chartHolder.obs) return;
      const title = `${st.name}${st.waterBody ? ` — ${st.waterBody}` : ""} · ${chartHolder.from} → ${chartHolder.to}`;
      const chartId = "hydro-modal-popup-chart";
      const tipId = "hydro-modal-tip-popup";
      const hint = "Hover a point on the chart for its exact reading.";
      const html = `
        <div class="hydro-modal-chart-row">
          <div class="hydro-modal-chart-wrap"><canvas id="${chartId}" role="img" aria-label="${title}"></canvas></div>
          <div class="hydro-modal-tooltip-panel" id="${tipId}" data-hint="${hint}"><p class="hydro-modal-tooltip-hint">${hint}</p></div>
        </div>
      `;
      openHydroContentModal(title, html, [
        { canvasId: chartId, build: (canvas) => new Chart(canvas.getContext("2d"), hydroPopupChartConfig(chartHolder.obs, false, tipId)) },
      ]);
    });
    pinBtn.addEventListener("click", () => {
      if (chartHolder.obs) addHydroPin(st, chartHolder.from, chartHolder.to, chartHolder.obs);
    });
    // Load the default range immediately so the popup isn't empty on open.
    loadHydroPopupObservations(st, fromInput.value, toInput.value, popupEl, chartHolder);
  });
  marker.on("popupclose", () => {
    if (chartHolder.chart) {
      chartHolder.chart.destroy();
      chartHolder.chart = null;
    }
  });
}

let hydroExpandModalCharts = []; // a card can have 2 charts (historical + selected-year), so this is a list now

/** Chart.js "external" tooltip renderer: instead of the library's own
 * floating box drawn ON TOP of the canvas — which, enlarged in the modal,
 * ends up covering a big share of the chart the instant you hover a point —
 * the exact same title/value text is written into a plain HTML panel
 * beside the chart. Same information as the built-in tooltip (it still
 * runs through each chart's own label/afterLabel callbacks to produce the
 * text — this only changes WHERE that text is drawn), just not sitting on
 * top of the data. `panel.dataset.hint` (set in the HTML) is restored when
 * nothing is hovered. */
function hydroExternalTooltipHandler(panelId) {
  return (context) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const tt = context.tooltip;
    if (!tt || tt.opacity === 0 || !tt.body || !tt.body.length) {
      panel.innerHTML = panel.dataset.hint ? `<p class="hydro-modal-tooltip-hint">${panel.dataset.hint}</p>` : "";
      return;
    }
    const parts = [];
    if (tt.title && tt.title.length) {
      parts.push(`<div class="hydro-modal-tooltip-title">${tt.title.join(", ")}</div>`);
    }
    tt.body.forEach((b, i) => {
      const box = tt.labelColors && tt.labelColors[i];
      const swatch = box ? `<span class="hydro-modal-tooltip-swatch" style="background:${box.backgroundColor}"></span>` : "";
      b.lines.forEach((line) => {
        parts.push(`<div class="hydro-modal-tooltip-line">${swatch}<span>${line}</span></div>`);
      });
    });
    panel.innerHTML = parts.join("");
  };
}

/** Which element to return keyboard focus to once the modal closes —
 * whatever had focus right before openHydroContentModal was called (almost
 * always the ⤢ expand button or card that triggered it), so closing via
 * Escape or the × button doesn't strand focus at the top of the page. */
let hydroModalReturnFocusEl = null;

/** Opens the shared "Expand" modal with arbitrary HTML content — any mix of
 * chart canvases, tables, and paragraphs, the same body a card already
 * shows inline, just bigger and on its own (not one isolated chart).
 * `chartBuilders` is a list of `{canvasId, build(canvas) => Chart}`, run
 * AFTER the HTML is inserted (a canvas has to exist in the DOM before
 * Chart.js can attach to it). No new fetch or recomputation happens here —
 * everything closes over data already sitting in memory. `subtitle` and
 * `badgeHtml` are optional — most callers (the station-popup expand modal)
 * only need a bare title; the hydrology basin/pooled modals also pass a
 * station/gauge subtitle line and an optional transboundary-catchment
 * badge, rendered in the sticky header underneath the title. */
function openHydroContentModal(title, bodyHtml, chartBuilders, { subtitle, badgeHtml } = {}) {
  const modal = document.getElementById("hydro-expand-modal");
  const titleEl = document.getElementById("hydro-expand-modal-title");
  const subtitleEl = document.getElementById("hydro-expand-modal-subtitle");
  const badgeEl = document.getElementById("hydro-expand-modal-badge");
  const bodyEl = document.getElementById("hydro-expand-modal-body");
  if (!modal || !titleEl || !bodyEl) return;
  hydroModalReturnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  titleEl.textContent = title;
  if (subtitleEl) {
    subtitleEl.textContent = subtitle || "";
    subtitleEl.hidden = !subtitle;
  }
  if (badgeEl) badgeEl.innerHTML = badgeHtml || "";
  hydroExpandModalCharts.forEach((c) => c.destroy());
  hydroExpandModalCharts = [];
  bodyEl.innerHTML = bodyHtml;
  bodyEl.scrollTop = 0;
  modal.hidden = false;
  (chartBuilders || []).forEach(({ canvasId, build }) => {
    const canvas = document.getElementById(canvasId);
    if (canvas) hydroExpandModalCharts.push(build(canvas));
  });
}

function closeHydroExpandModal() {
  const modal = document.getElementById("hydro-expand-modal");
  if (modal) modal.hidden = true;
  hydroExpandModalCharts.forEach((c) => c.destroy());
  hydroExpandModalCharts = [];
  hydroModalReturnFocusEl?.focus?.();
  hydroModalReturnFocusEl = null;
}

function setupHydroExpandModal() {
  const modal = document.getElementById("hydro-expand-modal");
  const closeBtn = document.getElementById("hydro-expand-modal-close");
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = "1";
  closeBtn?.addEventListener("click", closeHydroExpandModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeHydroExpandModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeHydroExpandModal();
  });
}

/** Loads dashboard/hydro_stations.json (Lithuanian Hydrometeorological
 * Service water-gauging stations — see the file's own "source" field) and
 * builds: the toggleable map marker layer and the "jump to station" dropdown
 * in Map settings. Stations don't depend on dataset/year, so this runs once
 * at map init rather than per-dataset-switch. Markers are triangular (see
 * hydroStationTriangleIcon) since Leaflet's circleMarker can't render
 * non-circular shapes. Hovering a marker expands it and shows its name
 * (setHydroMarkerStyle + bindTooltip); clicking
 * one opens a small popup with a date-range chart (bindPopup handles the
 * click itself, no separate click handler needed) — from there, "+ Sidebar"
 * pins that result into the Hydrology tab of the right-hand dashboards
 * panel (see addHydroPin) so it doesn't have to be re-searched later. */
function loadHydroStations(map) {
  fetch(`hydro_stations.json?t=${Date.now()}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.stations)) return;
      data.stations.forEach((st) => { st.name = translateStationName(st.name); });
      state.hydroStations = data.stations;

      const layer = L.layerGroup();
      const markers = [];
      data.stations.forEach((st) => {
        if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) {
          markers.push(null);
          return;
        }
        const marker = L.marker([st.lat, st.lon], {
          pane: "hydroStationPane",
          icon: hydroStationTriangleIcon(HYDRO_MARKER_RADIUS, HYDRO_MARKER_FILL_DEFAULT, HYDRO_MARKER_STROKE_DEFAULT, 1.5),
        });
        marker._radius = HYDRO_MARKER_RADIUS;
        marker._fillColor = HYDRO_MARKER_FILL_DEFAULT;
        marker._strokeColor = HYDRO_MARKER_STROKE_DEFAULT;
        marker._strokeWidth = 1.5;
        // Hover reverts to this rather than the shared default, so a
        // persistently-restyled marker (see highlightAnalysisStations)
        // doesn't snap back to the plain size on mouseout.
        marker._baseRadius = HYDRO_MARKER_RADIUS;
        marker.bindTooltip(st.name, { direction: "top", offset: [0, -6] });
        marker.bindPopup(buildHydroPopupHtml(st), { minWidth: 330, maxWidth: 360 });
        wireHydroPopup(marker, st);
        marker.on("mouseover", () => setHydroMarkerStyle(marker, { radius: HYDRO_MARKER_RADIUS_HOVER }));
        marker.on("mouseout", () => setHydroMarkerStyle(marker, { radius: marker._baseRadius }));
        marker.on("click", () => {
          if (state.map.hydrologyMapMode && analysisStationCodes().has(st.code)) scrollToBasinCard(st.code);
        });
        layer.addLayer(marker);
        markers.push(marker);
      });
      state.map.hydroStationsLayer = layer;
      state.map.hydroStationMarkers = markers;
      if (state.map.opts.showHydroStations) layer.addTo(map);

      const select = document.getElementById("hydro-station-select");
      if (select) {
        // Grouped by river (waterBody) and sorted alphabetically within each
        // group -- option values stay the ORIGINAL array index (what
        // goToHydroStation expects), only the displayed order changes.
        const withIndex = data.stations.map((st, i) => ({ st, i }));
        withIndex.sort((a, b) => {
          const bodyCmp = (a.st.waterBody || "").localeCompare(b.st.waterBody || "");
          return bodyCmp !== 0 ? bodyCmp : a.st.name.localeCompare(b.st.name);
        });
        let currentGroup = null;
        let groupEl = select;
        withIndex.forEach(({ st, i }) => {
          const groupKey = st.waterBody || "Other";
          if (groupKey !== currentGroup) {
            currentGroup = groupKey;
            groupEl = document.createElement("optgroup");
            groupEl.label = groupKey;
            select.appendChild(groupEl);
          }
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = st.name;
          groupEl.appendChild(opt);
        });
      }
    })
    .catch((e) => console.warn("Could not load hydro_stations.json", e));
}

/** Pans to the hydrological station at `index` (into state.hydroStations),
 * making sure the station layer is visible and opening that station's
 * popup so its name and readings are shown immediately, matching
 * click-to-open behavior for stations navigated to via the "jump to
 * station" dropdown. */
function goToHydroStation(index) {
  const map = state.map.instance;
  const st = state.hydroStations[index];
  if (!map || !st) return;
  map.setView([st.lat, st.lon], 14);

  if (!state.map.opts.showHydroStations) {
    state.map.opts.showHydroStations = true;
    const cb = document.querySelector('[data-opt="hydro-stations"]');
    if (cb) cb.checked = true;
    applyOverlayVisibility();
  }
  const marker = state.map.hydroStationMarkers[index];
  if (marker) marker.openPopup();
}

function setupHydroStationJump() {
  const btn = document.getElementById("hydro-station-go-btn");
  const select = document.getElementById("hydro-station-select");
  if (!btn || !select) return;
  btn.addEventListener("click", () => {
    const idx = parseInt(select.value, 10);
    if (Number.isFinite(idx)) goToHydroStation(idx);
  });
}

// ── Hydrology sidebar (pinned station results) ──────────────────────────────
// There's no dedicated Hydrology tab any more — instead, "+ Sidebar" on a
// station popup (see wireHydroPopup) saves that exact station/date-range
// result into a "Hydrology" tab inside the right-hand Dashboards panel, next
// to the existing land-cover Charts tab. Pins persist to localStorage so
// switching datasets (which reloads the page) or reopening the dashboard
// later doesn't lose them — the whole point is not having to re-search.

const HYDRO_PINS_STORAGE_KEY = "lt-dashboard-hydro-pins";
const HYDRO_PIN_MAX_COUNT = 20; // soft cap so localStorage can't grow unbounded

const hydroPinCharts = new Map(); // pin id -> Chart instance, for cleanup on re-render

/** avg/min/max/latest for one numeric field across a list of observations,
 * ignoring nulls (e.g. discharge is often unmeasured). Null if no values. */
function computeHydroStats(obs, field) {
  // observationTimeUtc sorts correctly as a plain string (ISO-ish,
  // "YYYY-MM-DD HH:MM:SS") -- sorted defensively here since `latest` must be
  // the chronologically last reading, not just whatever happened to be last
  // in the array the API returned.
  const sorted = [...obs].sort((a, b) => (a.observationTimeUtc < b.observationTimeUtc ? -1 : a.observationTimeUtc > b.observationTimeUtc ? 1 : 0));
  const vals = sorted.map((o) => o[field]).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return { avg: sum / vals.length, min: Math.min(...vals), max: Math.max(...vals), latest: vals[vals.length - 1] };
}

function fmtHydroVal(v, decimals, unit) {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(decimals)} ${unit}`;
}

function loadHydroPinsFromStorage() {
  try {
    const raw = localStorage.getItem(HYDRO_PINS_STORAGE_KEY);
    state.pinnedHydroStations = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn("Could not read pinned hydro stations from localStorage", e);
    state.pinnedHydroStations = [];
  }
}

function saveHydroPinsToStorage() {
  try {
    localStorage.setItem(HYDRO_PINS_STORAGE_KEY, JSON.stringify(state.pinnedHydroStations));
  } catch (e) {
    console.warn("Could not save pinned hydro stations to localStorage", e);
    showHydroNotice("Pin saved for this session only (browser storage unavailable).");
  }
}

/** Opens the right-hand Dashboards panel (if collapsed) and switches it to
 * the Pinned sub-tab, so pinning a station gives visible confirmation
 * instead of silently saving somewhere off-screen. Also switches to the
 * Home tab first, since the Dashboards panel only exists there but the map
 * (and its station popups) stays interactive on every top-level tab. */
function revealPinsSidebar() {
  document.querySelector('.tab[data-tab="home"]')?.click();
  document.getElementById("dashboards-toggle-btn")?.click();
  const tabBtn = document.querySelector('.dashboards-tab[data-dashtab="pins"]');
  if (tabBtn && !tabBtn.classList.contains("active")) tabBtn.click();
}

/** Saves one station/date-range result (same shape as loaded in the popup)
 * as a pinned card. Re-pinning the same station+range updates it in place
 * rather than duplicating it; otherwise the newest pin goes to the top and
 * the oldest is dropped once HYDRO_PIN_MAX_COUNT is exceeded. */
function addHydroPin(st, from, to, obs) {
  const id = `${st.code}|${from}|${to}`;
  const pin = { id, code: st.code, name: st.name, waterBody: st.waterBody || "", from, to, obs, pinnedAt: Date.now() };
  const existingIdx = state.pinnedHydroStations.findIndex((p) => p.id === id);
  if (existingIdx >= 0) {
    state.pinnedHydroStations[existingIdx] = pin;
  } else {
    state.pinnedHydroStations.unshift(pin);
    if (state.pinnedHydroStations.length > HYDRO_PIN_MAX_COUNT) {
      state.pinnedHydroStations.length = HYDRO_PIN_MAX_COUNT;
      showHydroNotice(`Pin limit (${HYDRO_PIN_MAX_COUNT}) reached — oldest pin removed.`);
    }
  }
  saveHydroPinsToStorage();
  renderHydroPins();
  revealPinsSidebar();
}

function removeHydroPin(id) {
  state.pinnedHydroStations = state.pinnedHydroStations.filter((p) => p.id !== id);
  saveHydroPinsToStorage();
  renderHydroPins();
}

/** Rebuilds the pinned-station card list in the sidebar. Each card gets its
 * own small fixed-size chart (same config as the popup's) — Chart.js
 * instances from the previous render are destroyed first since the canvases
 * they were attached to are about to be replaced via innerHTML. */
function renderHydroPins() {
  const emptyEl = document.getElementById("hydro-pins-empty");
  const listEl = document.getElementById("hydro-pins-list");
  if (!listEl) return;

  hydroPinCharts.forEach((chart) => chart.destroy());
  hydroPinCharts.clear();

  const pins = state.pinnedHydroStations;
  if (emptyEl) emptyEl.hidden = pins.length > 0;

  listEl.innerHTML = pins
    .map((p, idx) => {
      const levelStats = computeHydroStats(p.obs, "waterLevel");
      const tempStats = computeHydroStats(p.obs, "waterTemperature");
      return `
        <div class="hydro-pin-card">
          <div class="hydro-pin-card-header">
            <div>
              <div class="hydro-pin-card-title">${p.name}</div>
              <div class="hydro-pin-card-sub">${p.waterBody ? `${p.waterBody} · ` : ""}${p.from} → ${p.to}</div>
            </div>
            <div class="hydro-pin-card-actions">
              <button type="button" class="hydro-pin-expand-btn" data-expand-pin="${p.id}" title="Expand graph" aria-label="Expand graph">⤢</button>
              <button type="button" class="hydro-pin-remove-btn" data-remove-pin="${p.id}" title="Remove" aria-label="Remove pin">&times;</button>
            </div>
          </div>
          <div class="hydro-pin-kpis">
            <span>Avg level ${fmtHydroVal(levelStats?.avg, 1, "cm")}</span>
            <span>Avg temp ${fmtHydroVal(tempStats?.avg, 1, "°C")}</span>
          </div>
          <div class="hydro-chart-wrap"><canvas id="hydro-pin-chart-${idx}" role="img"></canvas></div>
        </div>
      `;
    })
    .join("");

  pins.forEach((p, idx) => {
    const canvas = document.getElementById(`hydro-pin-chart-${idx}`);
    if (!canvas) return;
    hydroPinCharts.set(p.id, new Chart(canvas.getContext("2d"), hydroPopupChartConfig(p.obs, false)));
    canvas.setAttribute("aria-label", `Water level and temperature, ${p.name}, ${p.from} to ${p.to}`);
  });
}

function setupHydroPinsList() {
  const listEl = document.getElementById("hydro-pins-list");
  if (!listEl || listEl.dataset.bound) return;
  listEl.dataset.bound = "1";
  listEl.addEventListener("click", (e) => {
    const expandBtn = e.target.closest("[data-expand-pin]");
    if (expandBtn) {
      const pin = state.pinnedHydroStations.find((p) => p.id === expandBtn.dataset.expandPin);
      if (pin) {
        const title = `${pin.name}${pin.waterBody ? ` — ${pin.waterBody}` : ""} · ${pin.from} → ${pin.to}`;
        const chartId = "hydro-modal-pin-chart";
        const tipId = "hydro-modal-tip-pin";
        const hint = "Hover a point on the chart for its exact reading.";
        const html = `
          <div class="hydro-modal-chart-row">
            <div class="hydro-modal-chart-wrap"><canvas id="${chartId}" role="img" aria-label="${title}"></canvas></div>
            <div class="hydro-modal-tooltip-panel" id="${tipId}" data-hint="${hint}"><p class="hydro-modal-tooltip-hint">${hint}</p></div>
          </div>
        `;
        openHydroContentModal(title, html, [
          { canvasId: chartId, build: (canvas) => new Chart(canvas.getContext("2d"), hydroPopupChartConfig(pin.obs, false, tipId)) },
        ]);
      }
      return;
    }
    const btn = e.target.closest("[data-remove-pin]");
    if (!btn) return;
    removeHydroPin(btn.dataset.removePin);
  });
}

/** Charts / Hydrology tab switcher at the top of the right-hand Dashboards
 * panel — same active-class + hidden-toggle pattern used by the top-level
 * segmented control and the old Validation sub-tabs. Switching to Hydrology
 * also switches the MAP itself into "hydrology mode" (dimmed land-cover +
 * main rivers + highlighted analysis stations) and back again — this is the
 * only thing that triggers that map-mode change. */
function setupDashboardsTabs() {
  const wrap = document.querySelector(".dashboards-tabs");
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".dashboards-tab");
    if (!btn || btn.classList.contains("active")) return;
    wrap.querySelectorAll(".dashboards-tab").forEach((b) => b.classList.toggle("active", b === btn));
    const name = btn.dataset.dashtab;
    document.querySelectorAll(".dashboards-panel-body[data-dashtab-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.dashtabPanel !== name;
    });
    // Pinned stations are drawn from the same station set the Hydrology tab
    // shows on the map, so browsing pins keeps the map in hydrology mode too
    // (all stations visible, land-cover dimmed) instead of reverting to the
    // plain Charts-tab map the instant you leave the Hydrology tab itself.
    if (name === "hydrology" || name === "pins") enterHydrologyMapMode();
    else exitHydrologyMapMode();
  });
}

// ── Basin hydrology / land-cover correlation (map mode + sidebar) ──────────
// Built from analysis/basin_hydrology_correlation.py's output: for each of
// 16 "river units" (a basin + its main river, or a second comparably-sized
// river in the same basin), a Pearson/Spearman correlation between Esri
// land-cover class share and the most-upstream station's annual hydrology,
// year by year. See that script's own docstring for the full method and
// caveats — the short version is repeated in the sidebar intro text itself
// (index.html) so it's visible to whoever's reading the results, not just
// whoever reads this source file.

/** Master switch for the correlation half of the hydrology tab (takeaway
 * sentences, verdict cards, stats tables, the z-score comparison chart, and
 * the cross-basin "Combined" pooled/meta-analysis view). Off for now -- the
 * user only wants a plain side-by-side land-cover / discharge comparison
 * per basin -- but every function behind it is left fully intact so
 * flipping this back to true restores the previous behavior exactly, no
 * rewrite needed. See buildUnitCardHtml, openHydroUnitModal,
 * renderBasinOverviewHtml, and renderMultiBasinHtml for where this branches. */
const SHOW_HYDRO_CORRELATION = false;

let basinCorrelationData = [];
let basinRiversGeoJson = null;
/** Set inside main() to the real saveStateAndReload closure — lets
 * enterHydrologyMapMode (defined here, outside that closure) trigger the
 * same save-state-then-reload path to force dataset=esri. */
let saveStateAndReloadFn = null;
/** basin name -> [{code, name}, ...] — EVERY station geometrically inside
 * that basin (not just the 1-2 "most upstream on the main river" ones used
 * for correlation) — see write_basin_stations_geojson in the Python script. */
let basinStationsMap = {};
const basinChartInstances = new Map(); // station_code(-hist|-year) or "pooled-*" -> Chart instance

function analysisStationCodes() {
  return new Set(basinCorrelationData.filter((r) => r.station_code).map((r) => r.station_code));
}

/** Placeholder cards shown the instant the Hydrology tab's data starts
 * loading, before the fetches resolve, so the panel never sits blank for
 * however long that takes. */
function renderHydroLoadingSkeleton() {
  const listEl = document.getElementById("hydro-basin-list");
  if (!listEl) return;
  destroyBasinCharts();
  listEl.innerHTML = Array.from({ length: 3 })
    .map(() => `
      <div class="hydro-basin-card hydro-skeleton-card" aria-hidden="true">
        <div class="hydro-skeleton-line hydro-skeleton-line-title"></div>
        <div class="hydro-skeleton-line hydro-skeleton-line-sub"></div>
        <div class="hydro-skeleton-block"></div>
      </div>
    `)
    .join("");
}

/** Visible failure state (replacing what used to be a console.warn-only
 * silent failure) with a working Retry button that re-invokes whatever the
 * caller passes as `retryFn`. */
function renderHydroErrorState(retryFn) {
  const listEl = document.getElementById("hydro-basin-list");
  if (!listEl) return;
  destroyBasinCharts();
  listEl.innerHTML = `
    <div class="hydro-error-card">
      <p>Could not load the basin analysis data.</p>
      <button type="button" class="hydro-error-retry-btn">Retry</button>
    </div>
  `;
  listEl.querySelector(".hydro-error-retry-btn")?.addEventListener("click", () => {
    if (typeof retryFn === "function") retryFn();
  });
}

/** Small dismissible inline notice — auto-dismisses after 8s, or on click.
 * Defaults to the sidebar's own notice area; pass an explicit `container`
 * (e.g. a station popup's own notice slot) to surface it there instead.
 * No-ops (console.warn only) if neither target exists, rather than
 * throwing. */
function showHydroNotice(msg, container) {
  const area = container || document.getElementById("hydro-notice-area");
  if (!area) { console.warn("[hydro notice]", msg); return; }
  const el = document.createElement("div");
  el.className = "hydro-notice";
  el.innerHTML = `<span>${msg}</span><button type="button" class="hydro-notice-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector(".hydro-notice-close").addEventListener("click", () => el.remove());
  area.prepend(el);
  setTimeout(() => { if (el.isConnected) el.remove(); }, 8000);
}

async function loadBasinHydrologyData() {
  renderHydroLoadingSkeleton();
  let ok = false;
  try {
    const [corrResp, riversResp, stationsResp] = await Promise.all([
      fetch(resolveDataFileUrl("outputs/basin_hydrology_correlation.json")),
      fetch(resolveDataFileUrl("outputs/basin_hydrology_rivers.geojson")),
      fetch(resolveDataFileUrl("outputs/basin_hydrology_stations.json")),
    ]);
    const corrData = corrResp.ok ? await corrResp.json() : null;
    const validSchema = Array.isArray(corrData) && corrData.every((r) => typeof r.basin === "string");
    if (!validSchema) throw new Error("basin_hydrology_correlation.json failed the shape check");
    corrData.forEach((r) => { r.station_name = translateStationName(r.station_name); });
    basinCorrelationData = corrData;
    basinRiversGeoJson = riversResp.ok ? await riversResp.json() : null;
    basinStationsMap = stationsResp.ok ? await stationsResp.json() : {};
    ok = true;
  } catch (e) {
    console.warn("Could not load basin hydrology correlation data", e);
    basinCorrelationData = [];
    basinRiversGeoJson = null;
    basinStationsMap = {};
  }
  if (ok) renderBasinHydrologySidebar();
  else renderHydroErrorState(() => loadBasinHydrologyData());
}

// ── Correlation stats ────────────────────────────────────────────────────────
// Per-unit Pearson/Spearman r/p/q are precomputed server-side (permutation
// p-values + Benjamini-Hochberg q-values -- see basin_hydrology_correlation.py)
// and used as-is. The multi-basin "combined" view no longer recomputes a
// fresh correlation client-side (that required reconstructing a somewhat
// arbitrary pooled series and re-deriving significance from scratch, which
// is what the old from-scratch incomplete-beta t-test implementation lived
// here for); instead it does a Fisher-z META-ANALYSIS of those already-solid
// precomputed per-unit statistics -- see pooledCorrelationMeta/normCdf next
// to buildPooledAnalysis below.

/** Applies the opacity slider's CURRENT value to the raster pane while in
 * hydrology mode. This is a separate CSS-level dimming multiplier on top of
 * whatever the raster layer's own opacity already is (the same slider also
 * still drives that directly, for the flat-GeoTIFF case) — the combined
 * effect starts noticeably dim at the slider's default and brightens/dims
 * further as the slider moves, rather than being frozen at one hardcoded
 * value regardless of the slider. No-op outside hydrology mode. */
function applyHydrologyRasterOpacity() {
  const map = state.map.instance;
  if (!map || !state.map.hydrologyMapMode) return;
  const rasterPane = map.getPane("rasterPane");
  if (!rasterPane) return;
  const slider = document.getElementById("opacity-slider");
  const v = slider ? Number(slider.value) : 0.65;
  rasterPane.style.opacity = String(Number.isFinite(v) ? v : 0.65);
}

/** Reads the Filters panel's own basin checkboxes (getSelectedBasinIndices:
 * null = "All Lithuania", [] = none, [i,...] = specific basins) and resolves
 * them to basin-hydrology name strings — null (0 selected or "All
 * Lithuania") means "every basin", otherwise an array of 1+ names. Matched
 * by INDEX (lt_subbasins.json feature order, stable) rather than by the
 * checkbox's display-name text, since that text can be renamed/sanitized
 * (see sanitizeBasinDisplayName / config.namesByObjectId) independently of
 * the raw name this data was built from. Re-read fresh every time hydrology
 * mode is (re-)entered — basin-filter changes only take effect after "Apply
 * Filters" reloads the page anyway (same as the land-cover raster's own
 * basin mask), so there's nothing to keep live-synced. */
function getFocusedBasinNamesFromFilters() {
  const indices = getSelectedBasinIndices();
  if (!Array.isArray(indices) || !indices.length) return null;
  const names = indices.map((i) => basinCorrelationData.find((r) => r.basin_index === i)?.basin).filter(Boolean);
  return [...new Set(names)];
}

/** Rebuilds the rivers layer and shows/hides station markers to match
 * focusedBasinNames — the literal "other rivers and stations disappear"
 * behavior, same idea as the land-cover raster's own basin mask (Filters
 * panel), just applied to the hydrology-mode layers instead of the raster.
 * Shows EVERY station geometrically inside the focused basin(s)
 * (basinStationsMap), not just the 1-2 analysis picks — those still stand
 * out via highlightAnalysisStations, but the rest of the basin's local
 * gauging context stays visible too. */
function applyHydrologyBasinFocusToMap() {
  const map = state.map.instance;
  if (!map || !state.map.hydrologyMapMode) return;

  if (state.map.hydrologyRiversLayer) map.removeLayer(state.map.hydrologyRiversLayer);
  if (basinRiversGeoJson) {
    const features = focusedBasinNames
      ? basinRiversGeoJson.features.filter((f) => focusedBasinNames.includes(f.properties.basin))
      : basinRiversGeoJson.features;
    state.map.hydrologyRiversLayer = L.geoJSON(
      { type: "FeatureCollection", features },
      { pane: "hydrologyRiversPane", style: { color: "#0ea5e9", weight: 4, opacity: 0.9 } },
    );
    state.map.hydrologyRiversLayer.eachLayer((ly) => {
      const p = ly.feature?.properties;
      if (p) ly.bindTooltip(`${p.river} (${p.basin})`, { sticky: true });
    });
    state.map.hydrologyRiversLayer.addTo(map);
  }

  const visibleCodes = focusedBasinNames
    ? new Set(focusedBasinNames.flatMap((bn) => (basinStationsMap[bn] || []).map((s) => s.code)))
    : null;
  const markers = state.map.hydroStationMarkers || [];
  const stations = state.hydroStations || [];
  const layer = state.map.hydroStationsLayer;
  markers.forEach((marker, i) => {
    if (!marker || !layer) return;
    const st = stations[i];
    const show = !visibleCodes || (st && visibleCodes.has(st.code));
    if (show && !layer.hasLayer(marker)) layer.addLayer(marker);
    else if (!show && layer.hasLayer(marker)) layer.removeLayer(marker);
  });
}

/** Switches the map into hydrology mode: dims whatever land-cover layer is
 * currently showing (via the shared rasterPane, so this works the same for
 * flat GeoTIFF overlays and the Esri/GRPK XYZ tile pyramids without needing
 * per-layer-type handling), draws the basin main rivers, forces the
 * hydro-station layer visible, gives the analysis stations a distinct look,
 * and narrows both to whichever basin(s) are selected in Filters.
 *
 * The whole analysis is Esri-only (see basin_hydrology_correlation.py), so
 * if some other dataset is currently showing, this reloads the page with
 * dataset=esri forced (mirroring exactly how a normal Apply-Filters dataset
 * switch already works) and flags itself to resume the same Dashboards tab
 * (Hydrology or Pinned — whichever triggered this) once the reload lands —
 * see main()'s handling of saved.resumeDashTab. Changing the dataset away
 * from Esri afterwards, through the normal Filters + Apply flow, does NOT
 * set that flag, so that reload lands on the plain Land coverage / Charts
 * view instead — "switch away = leave hydrology mode", with no extra code
 * needed for that half. */
function enterHydrologyMapMode() {
  const map = state.map.instance;
  if (!map || state.map.hydrologyMapMode) return;

  const datasetSelect = document.getElementById("dataset-select");
  if (datasetSelect && datasetSelect.value !== "esri" && typeof saveStateAndReloadFn === "function") {
    const activeTab = document.querySelector(".dashboards-tab.active")?.dataset.dashtab || "hydrology";
    saveStateAndReloadFn("esri", { resumeDashTab: activeTab });
    return; // page is reloading
  }

  state.map.hydrologyMapMode = true;

  // Starting opacity tracks whatever the opacity slider is already set to
  // (not a fixed value) -- see applyHydrologyRasterOpacity, which the
  // slider's own input handler also calls while this mode is active, so it
  // stays a live, working control instead of being frozen.
  applyHydrologyRasterOpacity();

  state.map._hydroStationsVisibleBeforeHydroMode = state.map.opts.showHydroStations;
  if (!state.map.opts.showHydroStations) {
    state.map.opts.showHydroStations = true;
    const cb = document.querySelector('[data-opt="hydro-stations"]');
    if (cb) cb.checked = true;
    applyOverlayVisibility();
    refreshLegendForCurrentDataset();
  }

  highlightAnalysisStations(true);
  focusedBasinNames = getFocusedBasinNamesFromFilters();
  applyHydrologyBasinFocusToMap();
  renderBasinHydrologySidebar();
}

function exitHydrologyMapMode() {
  const map = state.map.instance;
  if (!map || !state.map.hydrologyMapMode) return;
  state.map.hydrologyMapMode = false;

  const rasterPane = map.getPane("rasterPane");
  if (rasterPane) rasterPane.style.opacity = "";

  if (state.map.hydrologyRiversLayer) map.removeLayer(state.map.hydrologyRiversLayer);

  // Undo any basin-focus filtering so every marker is back in the layer
  // group before we possibly hide the whole group below.
  const layer = state.map.hydroStationsLayer;
  if (layer) (state.map.hydroStationMarkers || []).forEach((m) => { if (m && !layer.hasLayer(m)) layer.addLayer(m); });
  focusedBasinNames = null;

  if (!state.map._hydroStationsVisibleBeforeHydroMode) {
    state.map.opts.showHydroStations = false;
    const cb = document.querySelector('[data-opt="hydro-stations"]');
    if (cb) cb.checked = false;
    applyOverlayVisibility();
    refreshLegendForCurrentDataset();
  }

  highlightAnalysisStations(false);
}

function highlightAnalysisStations(on) {
  const codes = analysisStationCodes();
  const markers = state.map.hydroStationMarkers || [];
  const stations = state.hydroStations || [];
  markers.forEach((marker, i) => {
    const st = stations[i];
    if (!marker || !st || !codes.has(st.code)) return;
    if (on) {
      marker._baseRadius = HYDRO_MARKER_RADIUS_ANALYSIS;
      setHydroMarkerStyle(marker, { radius: marker._baseRadius, fillColor: HYDRO_MARKER_FILL_ANALYSIS, strokeColor: HYDRO_MARKER_STROKE_ANALYSIS, strokeWidth: 2.5 });
    } else {
      marker._baseRadius = HYDRO_MARKER_RADIUS;
      setHydroMarkerStyle(marker, { radius: marker._baseRadius, fillColor: HYDRO_MARKER_FILL_DEFAULT, strokeColor: HYDRO_MARKER_STROKE_DEFAULT, strokeWidth: 1.5 });
    }
  });
}

function scrollToBasinCard(stationCode) {
  const el = document.querySelector(`[data-basin-card-station="${stationCode}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("hydro-basin-card-flash");
  setTimeout(() => el.classList.remove("hydro-basin-card-flash"), 1600);
}

/** Rounds a correlation coefficient that's genuinely indistinguishable from
 * zero (e.g. -0.0021) to a clean +0.00 before formatting, so toFixed(2)
 * never prints the confusing "-0.00". */
function fmtCorrNum(v, decimals) {
  if (v == null) return "—";
  const rounded = Math.abs(v) < 0.005 ? 0 : v;
  return rounded.toFixed(decimals);
}

function average(vals) {
  const nums = vals.filter((v) => v != null && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Adaptive-precision magnitude formatter for percentage-point-style
 * numbers: land-cover class shares range from under 1% (Wetland, Water) to
 * over 40% (Agriculture, Forest), so a fixed decimal count either rounds a
 * real small-class move down to "0.0" or wastes digits on a large-class one.
 * Returns just the formatted absolute-value string (no sign) — callers add
 * their own +/- prefix. */
function adaptivePrecision(v) {
  const a = Math.abs(v);
  if (a >= 10) return a.toFixed(0);
  if (a >= 1) return a.toFixed(1);
  if (a >= 0.1) return a.toFixed(2);
  return a.toFixed(3);
}

/** "wetter years" for a discharge station, "higher-water years" for a level
 * station — since "wetter" implies a physical volume that a bare stage
 * reading doesn't necessarily mean. */
function wetLabelFor(hydroMetric) {
  return hydroMetric === "discharge" ? "wetter years" : "higher-water years";
}

/** "a, b, and c" / "a and b" / "a" — plain English list joining, used for
 * both the takeaway sentence and the no-link summary line. */
function joinEnglishList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Maps a class's existing classCorrelationVerdict onto the three-tier
 * CLEAR/POSSIBLE/NONE model used by the takeaway + verdict cards — same
 * underlying numbers (spearman_r, spearman_q), just a display-layer name
 * for each tier. */
function classVerdictTier(s) {
  const v = classCorrelationVerdict(s);
  if (!v) return null;
  const tier = v.verdict === "correlates with" ? "CLEAR" : v.verdict === "likely correlates with" ? "POSSIBLE" : "NONE";
  return { tier, positive: v.positive };
}

/** Sample standard deviation (ddof=1) ignoring nulls/non-finite values.
 * null if fewer than 2 usable values -- matching average()'s "null means
 * undefined, not zero" convention so callers can tell "no spread" apart
 * from "not enough data to know the spread". */
function stddev(vals) {
  const nums = vals.filter((v) => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const ss = nums.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (nums.length - 1));
}

/** Elasticity: "for every 1% change in the hydrology metric, this class's
 * mapped share tends to change by E%" — a concrete SIZE to go with the
 * qualitative correlates-with/likely/unlikely verdict, since "tends to
 * line up with a higher X" says direction but not magnitude.
 *
 * Derived from the already-computed Pearson r plus the two series' own
 * pairwise-complete means and standard deviations: the ordinary-least-
 * squares slope of class-% regressed on the hydrology metric is the
 * standard identity `slope = pearson_r * (sdClass / sdHydro)` (percentage
 * points of class share per native unit of the metric); scaling that slope
 * by `hydroMean / classMean` converts "points per unit" into a unit-free
 * elasticity, "percent change in class share per percent change in the
 * metric," evaluated at each series' own multi-year average — the standard
 * economics-style elasticity formula, E = slope * (meanX / meanY).
 *
 * Deliberately Pearson-based, not Spearman-based: a rate/slope is
 * inherently a linear concept (how many units of Y per unit of X).
 * Spearman only knows rank order, so it has no analogous slope to derive
 * from — Spearman remains the headline "is there a link" statistic
 * elsewhere; this is purely "how big does that link look, assuming it's
 * roughly linear."
 *
 * Returns null if there are fewer than 3 pairwise-complete years for this
 * class, or if either mean is 0 (percent-of-zero is undefined). */
function classElasticity(r, cls) {
  const s = r.correlation?.per_class?.[cls];
  if (!s || s.pearson_r == null) return null;
  const years = r.correlation.years_used;
  const pairs = years
    .map((y) => [r.land_cover_annual_pct[y]?.[cls], r.hydro_annual[y]?.mean])
    .filter(([cv, hv]) => cv != null && Number.isFinite(cv) && hv != null && Number.isFinite(hv));
  if (pairs.length < 3) return null;
  const classVals = pairs.map((p) => p[0]);
  const hydroVals = pairs.map((p) => p[1]);
  const classMean = average(classVals);
  const hydroMean = average(hydroVals);
  const classSd = stddev(classVals);
  const hydroSd = stddev(hydroVals);
  if (!classSd || !hydroSd || !hydroMean || !classMean) return null;
  return s.pearson_r * (classSd / hydroSd) * (hydroMean / classMean);
}

/** One-sentence takeaway, as plain text (no markup, no "Takeaway:" prefix)
 * — names every class with at least a POSSIBLE link (CLEAR or POSSIBLE
 * tier), strongest first, or says plainly that nothing showed a convincing
 * link. Water and Wetland are excluded even when they technically clear the
 * correlation threshold: their own share is partly defined by how much
 * visible water there is, so a "link" there is closer to a tautology than a
 * finding (see the dedicated override in buildClassVerdictCardsHtml) and
 * doesn't belong in a sentence that's explicitly claiming "a real pattern."
 * Two callers: the styled .hydro-takeaway callout (buildHydroTakeawayHtml,
 * inside an expanded card/modal) and the plain clamped line on a compact,
 * collapsed sidebar card (F2). */
function buildHydroTakeawaySentence(r) {
  const n = r.correlation?.n ?? 0;
  const wetLabel = wetLabelFor(r.hydro_metric);
  const withR = Object.entries(r.correlation?.per_class || {})
    .filter(([cls]) => cls !== "Water" && cls !== "Wetland")
    .map(([cls, s]) => ({ cls, s, t: classVerdictTier(s) }))
    .filter(({ t }) => t && t.tier !== "NONE")
    .sort((a, b) => Math.abs(b.s.spearman_r) - Math.abs(a.s.spearman_r));

  if (!withR.length) {
    return `No land-cover class showed a convincing link with the river across these ${n} years.`;
  }
  const parts = withR.map(({ cls, t }) => `${cls.toLowerCase()} share tended to be ${t.positive ? "higher" : "lower"}`);
  return `In this basin, ${joinEnglishList(parts)} in ${wetLabel} — a real pattern in these ${n} years, but not proof that land cover drives the river.`;
}

/** The styled top-of-card callout — wraps buildHydroTakeawaySentence with
 * the "Takeaway:" prefix and the .hydro-takeaway box. */
function buildHydroTakeawayHtml(r) {
  return `<div class="hydro-takeaway">Takeaway: ${buildHydroTakeawaySentence(r)}</div>`;
}

/** Secondary "size of the effect" line inside a CLEAR/POSSIBLE verdict card
 * — the elasticity (see classElasticity), rescaled ×10 so "a 10% wetter
 * year" reads as a tangible, nameable event rather than an abstract 1%. Only
 * shown for discharge stations (a water-LEVEL series has no true zero, so
 * "10% higher" is meaningless — its mean is an arbitrary gauge datum) and
 * never for Water/Wetland (their own share moving with the metric is the
 * satellite seeing more water, not an effect worth sizing). One direction
 * only (elasticity is symmetric by construction, see the old
 * formatElasticityPhrase this replaces) since at ×10 scale a single
 * "roughly X% more/less" reads clearly without needing both cases spelled
 * out. */
function buildEffectSizeLine(r, cls, metricLabel) {
  if (r.hydro_metric !== "discharge" || cls === "Water" || cls === "Wetland") return "";
  const elasticity = classElasticity(r, cls);
  if (elasticity == null || !Number.isFinite(elasticity)) return "";
  const e10 = elasticity * 10;
  const absE10 = Math.abs(e10);
  const sizeWord = absE10 < 0.5 ? "barely measurable" : absE10 < 2 ? "small" : absE10 < 5 ? "moderate" : "large";
  const dirWord = e10 >= 0 ? "more" : "less";
  return `<div class="hydro-verdict-card-effect">Size of the effect: ${sizeWord} — a 10% wetter year lines up with roughly ${adaptivePrecision(e10)}% ${dirWord} ${cls.toLowerCase()} share.</div>`;
}

/** Per-class verdict CARDS (replaces the old buildPerClassVerdictHtml bullet
 * list and buildConclusionFromStats/buildHistoricalConclusion's top summary
 * sentence, both retired). CLEAR and POSSIBLE classes get their own card
 * (strongest |ρ| first), each stating the direction in plain language plus
 * a confidence chip; classes with no meaningful link are folded into one
 * shared "No clear link" line rather than one bullet each. Water and
 * Wetland are a special case: even when their correlation clears CLEAR or
 * POSSIBLE, mapped water/wetland extent is partly a direct readout of how
 * much water is visible, so calling that a "link" implies causality that
 * isn't there — those get fixed, non-causal text and are always listed
 * last among the linked cards. */
function buildClassVerdictCardsHtml(r, metricLabel) {
  const wetLabel = wetLabelFor(r.hydro_metric);
  const n = r.correlation?.n ?? 0;
  const all = Object.entries(r.correlation?.per_class || {}).map(([cls, s]) => ({ cls, s, t: classVerdictTier(s) }));
  const isWaterish = (cls) => cls === "Water" || cls === "Wetland";
  const linkedMain = all.filter(({ t, cls }) => t && t.tier !== "NONE" && !isWaterish(cls))
    .sort((a, b) => Math.abs(b.s.spearman_r) - Math.abs(a.s.spearman_r));
  const linkedWater = all.filter(({ t, cls }) => t && t.tier !== "NONE" && isWaterish(cls))
    .sort((a, b) => Math.abs(b.s.spearman_r) - Math.abs(a.s.spearman_r));
  const noneClasses = all.filter(({ t }) => !t || t.tier === "NONE").map(({ cls }) => cls);

  const mainCards = linkedMain.map(({ cls, t }) => {
    const dirWord = t.positive ? "higher" : "lower";
    const effectHtml = buildEffectSizeLine(r, cls, metricLabel);
    return t.tier === "CLEAR"
      ? `<div class="hydro-verdict-card verdict-clear">
          <div class="hydro-verdict-card-head">✓ Clear link — ${cls} share tended to be ${dirWord} in ${wetLabel}.</div>
          <span class="hydro-chip">${n} years · unlikely to be coincidence</span>
          ${effectHtml}
        </div>`
      : `<div class="hydro-verdict-card verdict-possible">
          <div class="hydro-verdict-card-head">◐ Possible link — ${cls} share tended to be ${dirWord} in ${wetLabel}, but with only ${n} years of data this could still be coincidence.</div>
          <span class="hydro-chip">${n} years · treat as a hint, not proof</span>
          ${effectHtml}
        </div>`;
  }).join("");

  const waterCards = linkedWater.map(({ cls }) => `
    <div class="hydro-verdict-card verdict-info">
      <div class="hydro-verdict-card-head">○ Mapped ${cls} naturally expands in ${wetLabel} — the satellite sees more water when there is more water.</div>
      <div class="hydro-verdict-card-sub">Shown for completeness, not as a finding.</div>
    </div>
  `).join("");

  const noneHtml = noneClasses.length
    ? `<div class="hydro-verdict-card hydro-verdict-none">No clear link: ${joinEnglishList(noneClasses)} didn't move together with the river in any consistent way.</div>`
    : "";

  return `<div class="hydro-verdict-cards">${mainCards}${waterCards}${noneHtml}</div>`;
}

/** Dynamically compares the currently-viewed map year against this
 * river-unit's own multi-year average, for both hydrology and whichever
 * land-cover class the CHART itself highlights as the biggest mover — the
 * tallest |σ| bar, not the largest raw percentage-point move, so the text
 * and the chart never point at two different classes. The transboundary
 * catchment caveat is NOT repeated here — it's shown once, as a badge, right
 * under the card header (see buildUnitCardHtml). */
function buildSelectedYearConclusion(result, year) {
  const hydroY = result.hydro_annual[year];
  const lcY = result.land_cover_annual_pct[year];
  if (!hydroY || !lcY) {
    return `No usable data for ${year} at this station${hydroY || lcY ? " (hydrology or land-cover data is missing for this year, not both)" : ""}.`;
  }
  const years = result.correlation.years_used;
  const isLevel = result.hydro_metric !== "discharge";
  const metricLabel = isLevel ? "water level" : "discharge";
  const hydroAvg = average(years.map((y) => result.hydro_annual[y]?.mean));
  let hydroPhrase = "";
  if (hydroAvg != null) {
    if (isLevel) {
      // Water level has no universal zero -- it's relative to each gauge's
      // own datum -- so an absolute-cm comparison is the honest one;
      // percent-of-mean would be datum-dependent (a gauge whose period mean
      // happens to sit near zero would show huge, meaningless percentages
      // for an ordinary few-cm swing).
      const diffCm = hydroY.mean - hydroAvg;
      hydroPhrase = `${metricLabel} was ${Math.abs(diffCm).toFixed(0)} cm ${diffCm >= 0 ? "above" : "below"} its ${years[0]}–${years[years.length - 1]} average`;
    } else {
      const diffPct = ((hydroY.mean - hydroAvg) / hydroAvg) * 100;
      hydroPhrase = `${metricLabel} was ${Math.abs(diffPct).toFixed(0)}% ${diffPct >= 0 ? "above" : "below"} its ${years[0]}–${years[years.length - 1]} average`;
    }
  }

  const z = zScoreSeriesForUnit(result);
  let biggest = null;
  for (const cls of Object.keys(HYDRO_CLASS_COLORS)) {
    const zVal = z.classes[cls]?.[year];
    if (zVal == null || !Number.isFinite(zVal)) continue;
    if (!biggest || Math.abs(zVal) > Math.abs(biggest.zVal)) biggest = { cls, zVal };
  }
  let lcPhrase = "";
  let avgForTiny = null;
  if (biggest) {
    const avg = average(years.map((y) => result.land_cover_annual_pct[y]?.[biggest.cls]));
    const val = lcY[biggest.cls];
    if (avg != null && val != null) {
      avgForTiny = avg;
      const diff = val - avg;
      const tinyNote = avg < 1 ? `, ${biggest.cls} is a tiny slice of this basin, so small changes look dramatic` : "";
      lcPhrase = `${biggest.cls} sat well ${diff >= 0 ? "above" : "below"} its usual share (${diff >= 0 ? "+" : "-"}${adaptivePrecision(diff)} points${tinyNote})`;
    }
  }

  // Water/Wetland's own share moving with the metric is mechanical (the
  // satellite sees more water in a wetter year), so it doesn't get the
  // "consistent with that pattern" causal-sounding framing the way another
  // class's link would.
  const linkStat = biggest && avgForTiny != null && biggest.cls !== "Water" && biggest.cls !== "Wetland"
    ? result.correlation?.per_class?.[biggest.cls]
    : null;
  const correlates = linkStat?.spearman_r != null && Math.abs(linkStat.spearman_r) >= 0.5;
  const linkNote = correlates
    ? ` — ${biggest.cls} share has historically tended to move ${linkStat.spearman_r > 0 ? "the same way as" : "the opposite way from"} ${metricLabel} in this basin`
    : "";

  if (!lcPhrase && !hydroPhrase) return `Not enough historical data to say how ${year} compares to other years.`;
  const sentences = [];
  if (lcPhrase) sentences.push(`The standout in ${year}: ${lcPhrase}${linkNote}.`);
  if (hydroPhrase) sentences.push(`${hydroPhrase.charAt(0).toUpperCase()}${hydroPhrase.slice(1)}.`);
  return sentences.join(" ");
}

/** Single-YEAR, per-class trailing context line for the selected-year bar
 * chart — NOT the multi-year "on average" rate (that belongs only under the
 * historical chart, where "on average" is actually true). Eligibility is
 * CLEAR/POSSIBLE and NOT Water/Wetland: their own share moving with the
 * metric is mechanical (the satellite sees more water in a wetter year), so
 * a "this class has tended to rise/fall with discharge" line under their
 * fixed "not a finding" override card would be a direct contradiction. No ρ
 * symbol -- the direction word is stated explicitly and repeated for BOTH
 * the points and the relative-% figure so the "13% relative..." ambiguity
 * from before can't recur. Styled neutral slate (.verdict-info), never
 * green/red, since sitting below average isn't "bad." Returns "" if nothing
 * qualifies or this year has no usable data, so callers can splice the
 * result in without an extra existence check. */
function buildSelectedYearPerClassHtml(r, year) {
  const lcY = r.land_cover_annual_pct[year];
  if (!lcY) return "";
  const years = r.correlation.years_used;
  const metricLabel = r.hydro_metric === "discharge" ? "discharge" : "water level";
  const entries = Object.entries(r.correlation?.per_class || {})
    .filter(([cls]) => cls !== "Water" && cls !== "Wetland")
    .map(([cls, s]) => ({ cls, s, t: classVerdictTier(s) }))
    .filter(({ t }) => t && t.tier !== "NONE");
  if (!entries.length) return "";
  entries.sort((a, b) => Math.abs(b.s.spearman_r) - Math.abs(a.s.spearman_r));
  const items = entries
    .map(({ cls, s, t }) => {
      const val = lcY[cls];
      const avg = average(years.map((y) => r.land_cover_annual_pct[y]?.[cls]));
      if (val == null || avg == null) return `<li class="verdict-info"><strong>${cls}</strong> — no data for ${year}.</li>`;
      const diffPts = val - avg;
      const diffPct = avg !== 0 ? (diffPts / avg) * 100 : null;
      const dirWord = diffPts >= 0 ? "above" : "below";
      const pctPhrase = diffPct != null ? ` (${adaptivePrecision(diffPct)}% ${dirWord} its own average)` : "";
      const trendWord = t.positive ? "rise" : "fall";
      return `<li class="verdict-info"><strong>${cls}</strong> sat ${adaptivePrecision(diffPts)} points ${dirWord} its usual share this year${pctPhrase} — a class that has tended to ${trendWord} with ${metricLabel} historically.</li>`;
    })
    .join("");
  return `<ul class="hydro-verdict-list">${items}</ul>`;
}

const HYDRO_CLASS_COLORS = { Water: "#1572a6", Wetland: "#7B68EE", Urban: "#e04d4d", Agriculture: "#d1a520", Forest: "#228B22" };

/** Converts a river-unit's raw yearly series into a z-score ("standard
 * deviations from that series' own multi-year mean") for both hydrology and
 * every land-cover class — datum-invariant (unlike "% of mean", which is
 * meaningless for water level's arbitrary gauge-relative zero) and scales
 * tiny-share classes (e.g. Water at <2% of a basin) onto the same footing as
 * large ones, so they're all directly comparable on one chart instead of
 * raw values that live on totally different scales. This is a pure display
 * transform (an affine rescale, same as the "% departure" version it
 * replaces) — it does NOT change what's statistically significant; the
 * precomputed per_class Pearson/Spearman stats from
 * basin_hydrology_correlation.py stay exactly correct without recomputing
 * anything. Guards: a series shorter than 3 years, or with zero spread
 * (sd null/0), is entirely null (no fabricated z-scores from an undefined
 * or zero denominator); an individual year missing its own value stays null
 * even when the rest of the series is valid. Native (non-standardized)
 * values are kept alongside so chart tooltips can show the real reading,
 * not just its z-score. */
function zScoreSeriesForUnit(r) {
  const years = r.correlation.years_used;
  const hydroVals = years.map((y) => r.hydro_annual[y]?.mean);
  const hydroMean = average(hydroVals);
  const hydroSd = stddev(hydroVals);
  const hydro = {};
  const hydroNative = {};
  years.forEach((y, i) => {
    const v = hydroVals[i];
    hydroNative[y] = v != null && Number.isFinite(v) ? v : null;
    hydro[y] = (years.length >= 3 && hydroSd && v != null && Number.isFinite(v)) ? (v - hydroMean) / hydroSd : null;
  });
  const classes = {};
  const classesNative = {};
  const classMeans = {};
  Object.keys(HYDRO_CLASS_COLORS).forEach((cls) => {
    const vals = years.map((y) => r.land_cover_annual_pct[y]?.[cls]);
    const mean = average(vals);
    const sd = stddev(vals);
    classMeans[cls] = mean;
    classes[cls] = {};
    classesNative[cls] = {};
    years.forEach((y, i) => {
      const v = vals[i];
      classesNative[cls][y] = v != null && Number.isFinite(v) ? v : null;
      classes[cls][y] = (years.length >= 3 && sd && v != null && Number.isFinite(v)) ? (v - mean) / sd : null;
    });
  });
  return { years, hydro, hydroNative, hydroMean, classes, classesNative, classMeans };
}

/** The full min..max integer year range for a series (not just the years
 * that actually have data) — so a chart's x-axis always shows every
 * calendar year in span, with a real visual gap (via spanGaps:false) over
 * any year that's missing, instead of silently stitching two non-adjacent
 * years together as if they were consecutive. */
function buildContinuousYearRange(years) {
  if (!years || !years.length) return [];
  const min = Math.min(...years);
  const max = Math.max(...years);
  const out = [];
  for (let y = min; y <= max; y++) out.push(y);
  return out;
}

/** Percent departure from a series' own mean, formatted as a signed string
 * ("+18% vs. average" / "-7% vs. average") — the same information the
 * charts used to plot directly before switching to σ; now shown as a
 * SUPPLEMENTARY tooltip line alongside σ and the raw reading, not instead
 * of them, since σ (unlike raw %) stays meaningful for water level's
 * arbitrary gauge-relative datum. null if the mean is missing or zero
 * (percent-of-zero is undefined). */
function formatPctFromMean(v, mean) {
  if (v == null || !Number.isFinite(v) || mean == null || !Number.isFinite(mean) || mean === 0) return null;
  const pct = ((v - mean) / mean) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs. average`;
}

/** {nativeStr, pctStr} for one hydrology reading — the raw value with
 * units, and its % departure from this series' own mean. Either half can
 * be null independently (e.g. pctStr is null when the mean is 0). */
function formatHydroNative(v, mean, metricLabel) {
  if (v == null || !Number.isFinite(v)) return null;
  const nativeStr = metricLabel === "Discharge" ? `${v.toFixed(2)} m³/s` : `${v.toFixed(0)} cm`;
  return { nativeStr, pctStr: formatPctFromMean(v, mean) };
}
function formatClassNative(v, mean) {
  if (v == null || !Number.isFinite(v)) return null;
  return { nativeStr: `${v.toFixed(2)} %`, pctStr: formatPctFromMean(v, mean) };
}

/** Chart.js color-alpha helper — takes any of this file's existing #rrggbb
 * class colors and returns an rgba() string at the given opacity. Used only
 * to FADE an existing color (never to introduce a new hue) so
 * non-notable classes visually recede on the multi-line charts. */
function withAlpha(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Whether a class's link is strong enough to draw at full opacity on a
 * multi-line chart — same |r|>=0.5 threshold as classCorrelationVerdict's
 * CLEAR/POSSIBLE tiers, so "faded on the chart" and "no clear link in the
 * text" always agree. */
function isNotableR(absR) {
  return absR != null && Number.isFinite(absR) && absR >= 0.5;
}

/** Shaded ±1σ "typical range" band behind every standardized chart — 0 is
 * "usual," inside the band is unremarkable, outside it is an unusual year.
 * A Chart.js plugin (not a dataset) so it draws behind the data regardless
 * of how many series are plotted, and works identically on both line and
 * bar charts. */
const typicalBandPlugin = {
  id: "typicalBand",
  beforeDraw(chart) {
    const y = chart.scales?.y, area = chart.chartArea;
    if (!y || !area) return;
    const top = y.getPixelForValue(1), bot = y.getPixelForValue(-1);
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(148,163,184,0.12)";
    ctx.fillRect(area.left, top, area.right - area.left, bot - top);
    ctx.restore();
  },
};

/** Dashed vertical divider on the selected-year bar charts, between the
 * reference river bar (always category index 0) and the land-cover class
 * bars that follow it — visually separates "the thing being compared
 * against" from "what's being compared." */
const barDividerPlugin = {
  id: "barDivider",
  afterDraw(chart) {
    const x = chart.scales?.x, area = chart.chartArea;
    if (!x || !area || chart.config.type !== "bar") return;
    const px = (x.getPixelForValue(0) + x.getPixelForValue(1)) / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "#94a3b8";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, area.top);
    ctx.lineTo(px, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/** Shared Chart.js options for the annual (multi-year line) z-score charts
 * — historical per-unit and the multi-basin pooled composite. `showNative`
 * adds TWO afterLabel tooltip lines with the real (non-standardized)
 * reading and its % departure from that series' own mean, threaded through
 * each dataset's own `nativeValues` array (parallel to `data`, pre-built as
 * {nativeStr, pctStr} objects) since a z-chart's raw y-value alone
 * ("1.34σ") isn't useful without knowing what that actually was in real
 * units, or by how much (in %) it actually differed from normal. That native
 * breakdown is still expand-modal-only (`expanded=true`) -- a hover box that
 * grows with extra text on the small inline card chart is unwanted there;
 * the modal used to deliver this via a side panel, now it's the same info in
 * Chart.js's own tooltip box instead (the side panel itself is retired, see
 * openHydroUnitModal), but WHERE it appears (inline vs. expanded) is
 * unchanged. */
function hydroAnnualChartOptions(yAxisTitle, showNative, expanded) {
  const labelCallback = (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(2)}σ`;
  const callbacks = expanded && showNative
    ? {
        label: labelCallback,
        afterLabel: (ctx) => {
          const nv = ctx.dataset.nativeValues?.[ctx.dataIndex];
          if (!nv) return [];
          const lines = [`Actual: ${nv.nativeStr}`];
          if (nv.pctStr) lines.push(nv.pctStr);
          return lines;
        },
      }
    : { label: labelCallback };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: true,
        position: "bottom",
        labels: {
          boxWidth: 12,
          usePointStyle: true,
          font: { size: 11 },
          // Faded-line datasets (see isNotableR/withAlpha in
          // buildHistoricalChart/buildPooledChart) get a faded legend entry
          // too -- same alpha-only rgba already used for the line itself,
          // no new hues -- so "which lines are notable" reads consistently
          // in the legend, not just on the chart (Section G).
          generateLabels(chart) {
            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
            items.forEach((item) => {
              const ds = chart.data.datasets[item.datasetIndex];
              if (ds && ds.faded) {
                item.fillStyle = ds.borderColor;
                item.strokeStyle = ds.borderColor;
                item.fontColor = "rgba(51, 65, 85, 0.45)";
              }
            });
            return items;
          },
        },
      },
      tooltip: { callbacks },
    },
    scales: {
      x: { ticks: { font: { size: 11 } } },
      y: {
        title: { display: true, text: yAxisTitle },
        ticks: { font: { size: 11 } },
        grid: {
          color: (ctx) => (ctx.tick.value === 0 ? "#94a3b8" : "#e5e7eb"),
          lineWidth: (ctx) => (ctx.tick.value === 0 ? 2 : 1),
        },
      },
    },
  };
}

/** Line chart of z-score (standard deviations from this station's own
 * period mean) — hydrology and all 5 land-cover classes on ONE shared axis
 * (all unitless σ, so directly comparable regardless of each series' native
 * unit/scale). Flat, unfabricated segments (tension:0) with real markers on
 * every plotted point (pointRadius:3), and a genuine break in the line
 * (spanGaps:false) over any year missing from this station's own record —
 * the x-axis spans every calendar year in range even when some are absent,
 * so a gap reads as "no data that year", not an invisible smoothed-over
 * jump. Classes without at least a moderate historical link (|ρ|<0.5) are
 * drawn at reduced opacity (same color, just faded) so the lines that
 * actually matter aren't lost in the spaghetti — the hydrology metric
 * itself is always full-opacity since it's the reference series, not a
 * candidate for "notable or not." `expanded` is true only when this chart
 * is being built inside the full-card modal (see openHydroUnitModal). */
function buildHistoricalChart(canvas, result, expanded) {
  const z = zScoreSeriesForUnit(result);
  const years = buildContinuousYearRange(z.years);
  const metricLabel = result.hydro_metric === "discharge" ? "Discharge" : "Water level";
  const datasets = [
    {
      label: metricLabel,
      data: years.map((y) => z.hydro[y] ?? null),
      nativeValues: years.map((y) => formatHydroNative(z.hydroNative[y], z.hydroMean, metricLabel)),
      borderColor: "#0f172a",
      backgroundColor: "#0f172a",
      pointBackgroundColor: "#0f172a",
      tension: 0,
      pointRadius: 3,
      spanGaps: false,
      borderWidth: 2.5,
    },
    ...Object.entries(HYDRO_CLASS_COLORS).map(([cls, color]) => {
      const absR = result.correlation?.per_class?.[cls]?.spearman_r != null ? Math.abs(result.correlation.per_class[cls].spearman_r) : null;
      const faded = !isNotableR(absR);
      const drawColor = faded ? withAlpha(color, 0.25) : color;
      return {
        label: cls,
        data: years.map((y) => z.classes[cls][y] ?? null),
        nativeValues: years.map((y) => formatClassNative(z.classesNative[cls][y], z.classMeans[cls])),
        borderColor: drawColor,
        backgroundColor: drawColor,
        pointBackgroundColor: drawColor,
        faded,
        tension: 0,
        pointRadius: 3,
        spanGaps: false,
      };
    }),
  ];
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: years, datasets },
    options: hydroAnnualChartOptions("vs. a typical year", true, expanded),
    plugins: [typicalBandPlugin],
  });
  canvas.setAttribute("aria-label", `Annual standardized departures, ${result.river} at ${result.station_name}, ${years[0]}–${years[years.length - 1]}`);
  return chart;
}

/** Plain (non-standardized, no correlation grading) chart options shared by
 * buildRawLandCoverChart/buildRawHydroChart -- the simple side-by-side view
 * used while SHOW_HYDRO_CORRELATION is off. Same visual language as
 * hydroAnnualChartOptions (legend position, font sizes) minus the z-score
 * tooltip formatting and the faded-line-by-r legend logic, since there's no
 * correlation here to grade lines against. */
function rawHydroChartOptions(yAxisTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, position: "bottom", labels: { boxWidth: 12, usePointStyle: true, font: { size: 11 } } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(2)}` } },
    },
    scales: {
      x: { ticks: { font: { size: 11 } } },
      y: { title: { display: true, text: yAxisTitle }, ticks: { font: { size: 11 } } },
    },
  };
}

/** Land-cover class share by year, plain % (no z-score) -- all 5 classes on
 * one chart, same colors as everywhere else (HYDRO_CLASS_COLORS), but no
 * fading-by-correlation-strength since this view draws no correlation at
 * all. Left half of the side-by-side comparison used while
 * SHOW_HYDRO_CORRELATION is off. */
function buildRawLandCoverChart(canvas, result) {
  const years = buildContinuousYearRange(Object.keys(result.land_cover_annual_pct).map(Number));
  const datasets = Object.entries(HYDRO_CLASS_COLORS).map(([cls, color]) => ({
    label: cls,
    data: years.map((y) => result.land_cover_annual_pct[y]?.[cls] ?? null),
    borderColor: color,
    backgroundColor: color,
    pointBackgroundColor: color,
    tension: 0,
    pointRadius: 3,
    spanGaps: false,
  }));
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: years, datasets },
    options: rawHydroChartOptions("% of classified area"),
  });
  canvas.setAttribute("aria-label", `Land-cover class share by year, ${result.basin} basin, ${years[0]}–${years[years.length - 1]}`);
  return chart;
}

/** The station's raw annual discharge/water-level value by year -- one
 * line, native units, no standardization. Right half of the side-by-side
 * comparison used while SHOW_HYDRO_CORRELATION is off. */
function buildRawHydroChart(canvas, result) {
  const years = buildContinuousYearRange(Object.keys(result.hydro_annual).map(Number));
  const metricLabel = result.hydro_metric === "discharge" ? "Discharge (m³/s)" : "Water level (cm)";
  const datasets = [{
    label: metricLabel,
    data: years.map((y) => result.hydro_annual[y]?.mean ?? null),
    borderColor: "#0f172a",
    backgroundColor: "#0f172a",
    pointBackgroundColor: "#0f172a",
    tension: 0,
    pointRadius: 3,
    spanGaps: false,
    borderWidth: 2.5,
  }];
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: years, datasets },
    options: rawHydroChartOptions(metricLabel),
  });
  canvas.setAttribute("aria-label", `${metricLabel} by year, ${result.river} at ${result.station_name}, ${years[0]}–${years[years.length - 1]}`);
  return chart;
}

/** Diverging bar chart: how far each class (and the hydrology metric itself
 * — now on the same unitless σ scale, so it fits on this chart too) sat
 * above (green) or below (red) its own period mean in the selected year.
 * The reference river bar is always first (bold tick label, dark outline,
 * dashed divider before the classes that follow it — see barDividerPlugin)
 * so "what we're comparing against" reads before "what's being compared."
 * The y-axis is forced symmetric about zero (suggestedMin/Max = ±the
 * largest bar) and the zero gridline is drawn thicker/darker than the
 * others, so "above vs. below normal" reads at a glance instead of being
 * an arbitrary auto-scaled range. */
function buildSelectedYearChart(canvas, result, year, expanded) {
  const z = zScoreSeriesForUnit(result);
  const classes = Object.keys(HYDRO_CLASS_COLORS);
  const metricLabel = result.hydro_metric === "discharge" ? "Discharge" : "Water level";
  const riverLabel = `River ${result.hydro_metric === "discharge" ? "discharge" : "level"}`;
  const labels = [riverLabel, ...classes];
  const vals = [z.hydro[year] ?? null, ...classes.map((c) => z.classes[c][year] ?? null)];
  const nativeInfo = [
    formatHydroNative(z.hydroNative[year], z.hydroMean, metricLabel),
    ...classes.map((c) => formatClassNative(z.classesNative[c][year], z.classMeans[c])),
  ];
  const colors = vals.map((v) => (v == null ? "#cbd5e1" : v >= 0 ? "#16a34a" : "#dc2626"));
  const borderColors = vals.map((_, i) => (i === 0 ? "#0f172a" : "transparent"));
  const borderWidths = vals.map((_, i) => (i === 0 ? 2 : 0));
  const finiteVals = vals.filter((v) => v != null && Number.isFinite(v));
  const maxAbs = finiteVals.length ? Math.max(...finiteVals.map(Math.abs), 0.5) : 1;
  const barLabelCallback = (ctx) => `${ctx.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(2)}σ`;
  const barCallbacks = expanded
    ? {
        label: barLabelCallback,
        afterLabel: (ctx) => {
          const nv = ctx.dataset.nativeValues?.[ctx.dataIndex];
          if (!nv) return [];
          const lines = [`Actual: ${nv.nativeStr}`];
          if (nv.pctStr) lines.push(nv.pctStr);
          return lines;
        },
      }
    : { label: barLabelCallback };
  const chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets: [{ label: `${year} vs. period mean`, data: vals, nativeValues: nativeInfo, backgroundColor: colors, borderColor: borderColors, borderWidth: borderWidths }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: barCallbacks },
      },
      scales: {
        x: { ticks: { font: (ctx) => ({ size: 11, weight: ctx.index === 0 ? "bold" : "normal" }) } },
        y: {
          suggestedMin: -maxAbs,
          suggestedMax: maxAbs,
          title: { display: true, text: "vs. a typical year" },
          ticks: { font: { size: 11 } },
          grid: {
            color: (ctx) => (ctx.tick.value === 0 ? "#94a3b8" : "#e5e7eb"),
            lineWidth: (ctx) => (ctx.tick.value === 0 ? 2 : 1),
          },
        },
      },
    },
    plugins: [typicalBandPlugin, barDividerPlugin],
  });
  canvas.setAttribute("aria-label", `${year} standardized departure by land-cover class, ${result.river} at ${result.station_name}`);
  return chart;
}

/** Explicit r/p/q table — Spearman first (it's the headline statistic; see
 * buildHydroTakeawayHtml), Pearson alongside for comparison, plus the
 * FDR-adjusted q for both (the honest "does this survive testing 5 classes
 * at once" number, not just the raw per-class p). Takes a per_class-shaped
 * object so it works for a real river-unit's precomputed stats. */
function buildStatsTableHtml(perClass) {
  const entries = Object.entries(perClass || {}).sort((a, b) => {
    const aAbs = a[1]?.spearman_r != null ? Math.abs(a[1].spearman_r) : -1;
    const bAbs = b[1]?.spearman_r != null ? Math.abs(b[1].spearman_r) : -1;
    return bAbs - aAbs;
  });
  const rows = entries
    .map(([cls, s]) => {
      if (s.spearman_r == null) {
        return `<tr><td>${cls}</td><td colspan="7" class="hydro-stats-na">${s.note || "not enough data"}</td></tr>`;
      }
      const v = classCorrelationVerdict(s);
      const verdictWord = v ? (v.verdict === "correlates with" ? "Clear link" : v.verdict === "likely correlates with" ? "Possible link" : "No link") : "—";
      return `
        <tr>
          <td>${cls}</td>
          <td class="num">${fmtCorrNum(s.spearman_r, 2)}</td>
          <td class="num">${s.spearman_p != null ? s.spearman_p.toFixed(3) : "—"}</td>
          <td class="num">${s.spearman_q != null ? s.spearman_q.toFixed(3) : "—"}</td>
          <td class="num">${s.pearson_r != null ? fmtCorrNum(s.pearson_r, 2) : "—"}</td>
          <td class="num">${s.pearson_p != null ? s.pearson_p.toFixed(3) : "—"}</td>
          <td class="num">${s.pearson_q != null ? s.pearson_q.toFixed(3) : "—"}</td>
          <td>${verdictWord}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="hydro-table-scroll">
      <table class="hydro-stats-table">
        <caption class="visually-hidden">Correlation statistics for each land-cover class against the river</caption>
        <thead>
          <tr>
            <th rowspan="2" scope="col">Class</th>
            <th colspan="3" scope="colgroup" class="hydro-stats-group-head" title="Rank-based — robust for small samples (the verdicts use this one)">Spearman (headline)</th>
            <th colspan="3" scope="colgroup" class="hydro-stats-group-head" title="Straight-line version, shown for comparison">Pearson</th>
            <th rowspan="2" scope="col">Verdict</th>
          </tr>
          <tr>
            <th class="num" scope="col" title="Rank correlation, −1 to +1 — do the two move together across years?">ρ</th>
            <th class="num" scope="col">p</th>
            <th class="num" scope="col" title="Chance-adjusted p-value across the 5 classes — below 0.05 counts as significant">q</th>
            <th class="num" scope="col">r</th>
            <th class="num" scope="col">p</th>
            <th class="num" scope="col">q</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/** Plain-language, no-numbers verdict for ONE class's stats — exactly the 3
 * phrases asked for, no math: "correlates with" (a real, checkable pattern:
 * at least a moderate link AND it survives being FDR-corrected for testing
 * 5 classes at once), "likely correlates with" (a moderate-or-stronger raw
 * link, just not confidently significant at this small sample size), or
 * "unlikely correlates with" (weak/no link either way). Returns null if
 * there isn't a usable spearman_r for this class (too few years, or a
 * constant series) — caller shows a "not enough data" line for that case. */
function classCorrelationVerdict(s) {
  if (!s || s.spearman_r == null) return null;
  const absR = Math.abs(s.spearman_r);
  const q = s.spearman_q;
  let verdict;
  if (q != null && q < 0.05 && absR >= 0.5) verdict = "correlates with";
  else if (absR >= 0.5) verdict = "likely correlates with";
  else verdict = "unlikely correlates with";
  return { verdict, positive: s.spearman_r > 0 };
}

/** Maps a pooled per-class meta-analysis result ({r, lo, hi, p, k}) onto the
 * same CLEAR/POSSIBLE/NONE tier model as classVerdictTier (per-basin), so
 * the pooled card's takeaway, verdict cards, and stats-table verdict column
 * all agree with each other -- and with the per-basin system -- on what
 * counts as a "clear" vs "possible" link. */
function pooledVerdictTier(m) {
  if (!m) return null;
  const absR = Math.abs(m.r);
  const tier = m.p < 0.05 && absR >= 0.5 ? "CLEAR" : absR >= 0.5 ? "POSSIBLE" : "NONE";
  return { tier, positive: m.r > 0 };
}

/** "both gauges" for k=2 (the common case), "all {k} gauges" otherwise. */
function gaugesPhrase(k) {
  return k === 2 ? "both gauges" : `all ${k} gauges`;
}

/** Pooled equivalent of buildHydroTakeawayHtml — same one-sentence,
 * top-of-card summary, built from the meta-analytic verdicts instead of a
 * single station's own stats. Water/Wetland excluded for the same reason
 * (their own extent moving with flow is mechanical, not a finding). */
function buildPooledTakeawayHtml(pooled) {
  const withR = Object.entries(pooled.perClassStats || {})
    .filter(([cls]) => cls !== "Water" && cls !== "Wetland")
    .map(([cls, s]) => ({ cls, m: s.spearman, t: pooledVerdictTier(s.spearman) }))
    .filter(({ t }) => t && t.tier !== "NONE")
    .sort((a, b) => Math.abs(b.m.r) - Math.abs(a.m.r));

  if (!withR.length) {
    return `<div class="hydro-takeaway">Takeaway: No land-cover class showed a convincing link with the rivers across these gauges.</div>`;
  }
  const parts = withR.map(({ cls, t }) => `${cls.toLowerCase()} share tended to be ${t.positive ? "higher" : "lower"}`);
  return `<div class="hydro-takeaway">Takeaway: Across ${gaugesPhrase(pooled.k)}, ${joinEnglishList(parts)} in wetter years — a consistent pattern, but not proof that land cover drives the rivers.</div>`;
}

/** Pooled equivalent of buildClassVerdictCardsHtml, using the same shared
 * verdict-card CSS classes (Section C) and Water/Wetland override so the
 * combined card looks and reads exactly like a per-basin card, just with
 * "combined from {k} gauges" chips instead of "{n} years" ones. */
function buildPooledVerdictCardsHtml(pooled) {
  const k = pooled.k;
  const gauges = gaugesPhrase(k);
  const isWaterish = (cls) => cls === "Water" || cls === "Wetland";
  const all = Object.entries(pooled.perClassStats || {}).map(([cls, s]) => ({ cls, m: s.spearman, t: pooledVerdictTier(s.spearman) }));
  const linkedMain = all.filter(({ t, cls }) => t && t.tier !== "NONE" && !isWaterish(cls))
    .sort((a, b) => Math.abs(b.m.r) - Math.abs(a.m.r));
  const linkedWater = all.filter(({ t, cls }) => t && t.tier !== "NONE" && isWaterish(cls))
    .sort((a, b) => Math.abs(b.m.r) - Math.abs(a.m.r));
  const noneClasses = all.filter(({ t }) => !t || t.tier === "NONE").map(({ cls }) => cls);

  const mainCards = linkedMain.map(({ cls, t }) => {
    const dirWord = t.positive ? "higher" : "lower";
    return t.tier === "CLEAR"
      ? `<div class="hydro-verdict-card verdict-clear">
          <div class="hydro-verdict-card-head">✓ Clear link — ${cls} share tended to be ${dirWord} in wetter years, across ${gauges}.</div>
          <span class="hydro-chip">combined from ${k} gauges · unlikely to be coincidence</span>
        </div>`
      : `<div class="hydro-verdict-card verdict-possible">
          <div class="hydro-verdict-card-head">◐ Possible link — ${cls} share tended to be ${dirWord} in wetter years, across ${gauges}, but this could still be coincidence.</div>
          <span class="hydro-chip">combined from ${k} gauges · treat as a hint, not proof</span>
        </div>`;
  }).join("");

  const waterCards = linkedWater.map(({ cls }) => `
    <div class="hydro-verdict-card verdict-info">
      <div class="hydro-verdict-card-head">○ Mapped ${cls} naturally expands in wetter years — the satellite sees more water when there is more water.</div>
      <div class="hydro-verdict-card-sub">Shown for completeness, not as a finding.</div>
    </div>
  `).join("");

  const noneHtml = noneClasses.length
    ? `<div class="hydro-verdict-card hydro-verdict-none">No clear link: ${joinEnglishList(noneClasses)} didn't move together with the rivers in any consistent way.</div>`
    : "";

  return `<div class="hydro-verdict-cards">${mainCards}${waterCards}${noneHtml}</div>`;
}

/** The map's own year slider drives what "the selected singular year" means
 * — reads it directly off the slider's OWN current value, not off the
 * year-label's cached dataset attribute. The label is updated by a
 * SEPARATE 'input' listener (registered later, in main()) that also
 * resolves the dataset-specific raster year; since both listeners fire on
 * the same 'input' event, whichever runs first would otherwise see the
 * PREVIOUS tick's label text -- this is what caused the hydrology charts to
 * lag one slider step behind the map (e.g. showing 2022 while the map read
 * 2023). The slider element's own .value is native browser state and is
 * already current the instant 'input' fires, regardless of listener order,
 * so reading it directly here sidesteps the whole ordering problem. Since
 * the hydrology analysis is Esri-only, the calendar year IS the raw slider
 * value -- no dataset-specific raster-year remapping needed (see
 * readYearSliderMapPair, which does that remapping for the map layer). */
function getViewingCalendarYear() {
  const slider = document.getElementById("year-slider");
  const v = slider ? parseInt(slider.value, 10) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** Which basin(s) (if any) the map + sidebar are currently focused on —
 * null means the "all basins" overview, a 1-element array means the
 * single-basin view, 2+ means the separate-plus-combined multi-basin view.
 * Set in enterHydrologyMapMode from the Filters panel's own basin selection
 * (getFocusedBasinNamesFromFilters). */
let focusedBasinNames = null;

function destroyBasinCharts() {
  basinChartInstances.forEach((c) => c.destroy());
  basinChartInstances.clear();
  hydroLazyChartBuilders.clear();
  hydroChartRegistry.clear();
}

/** Given a compact card's own data-basin-card-station value, finds that
 * unit's full result object in basinCorrelationData and opens its modal —
 * shared by the click and keyboard handlers below. */
function openUnitModalForCard(card) {
  const stationCode = card.dataset.basinCardStation;
  const r = basinCorrelationData.find((x) => x.station_code === stationCode);
  if (r) openHydroUnitModal(r);
}

/** Delegated click/keyboard handling for the whole #hydro-basin-list, bound
 * ONCE — survives every innerHTML rebuild since the listener lives on the
 * container, not on the (constantly replaced) cards inside it. Handles
 * three things: (1) a compact/collapsed card ([data-open-modal="unit"]) —
 * click anywhere on it, or press Enter/Space while it's focused, opens that
 * unit's full modal directly (F3); (2) an already-expanded card's own
 * collapse/expand toggle (only reachable in the single-basin view, where
 * the card starts fully expanded and its charts are already built); (3) a
 * single chart's own "expand ⤢" button, which opens the SAME full-card
 * modal via hydroChartRegistry (no new fetch or recomputation — the same
 * in-memory data, just a fresh Chart.js instance targeting the modal's
 * canvas). */
function setupHydroCardToggles() {
  const listEl = document.getElementById("hydro-basin-list");
  if (!listEl || listEl.dataset.toggleBound) return;
  listEl.dataset.toggleBound = "1";
  listEl.addEventListener("click", (e) => {
    const expandBtn = e.target.closest("[data-expand-chart]");
    if (expandBtn) {
      const entry = hydroChartRegistry.get(expandBtn.dataset.expandChart);
      if (!entry) return;
      // Either expand button on a unit's card (historical or selected-year)
      // opens the SAME full-card view — every chart, table, and paragraph
      // that card has, not just the one chart whose button was clicked.
      if (entry.kind === "unit") openHydroUnitModal(entry.r);
      else if (entry.kind === "pooled") openHydroPooledModal(entry.pooled);
      return;
    }

    const compactCard = e.target.closest('[data-open-modal="unit"]');
    if (compactCard) {
      openUnitModalForCard(compactCard);
      return;
    }

    const toggleBtn = e.target.closest(".hydro-card-toggle");
    if (!toggleBtn) return;
    const bodyId = toggleBtn.getAttribute("aria-controls");
    const body = document.getElementById(bodyId);
    if (!body) return;
    const wasOpen = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!wasOpen));
    body.hidden = wasOpen;
    toggleBtn.classList.toggle("hydro-card-open", !wasOpen);
    if (!wasOpen) {
      const builder = hydroLazyChartBuilders.get(bodyId);
      if (builder) {
        hydroLazyChartBuilders.delete(bodyId);
        // Wait one frame before building: `body.hidden = false` above hasn't
        // actually been laid out by the browser yet in this same tick, so a
        // chart constructed synchronously right here would measure a
        // zero-size canvas (Chart.js's own well-known "created while hidden"
        // issue) and never repaint at the right size afterward -- most
        // visible on the bar chart, which (unlike the line chart) has no
        // points to force a later redraw. One rAF is enough for the browser
        // to complete the layout pass that removing `hidden` triggered.
        requestAnimationFrame(() => builder());
      }
    }
  });
  // role="button" elements aren't natively keyboard-activatable -- Enter and
  // Space have to be wired by hand per WAI-ARIA authoring practice.
  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const compactCard = e.target.closest('[data-open-modal="unit"]');
    if (!compactCard || e.target !== compactCard) return;
    e.preventDefault();
    openUnitModalForCard(compactCard);
  });
}

/** "2017–2024" (or a single year, "2024") — the from-to span for a section
 * header. The dataset name/N no longer appear here (see the "Year by
 * year" section rename): N lives in the verdict chips, the Esri/source
 * mention lives in the card's bottom footnote. */
function formatYearSpan(years) {
  if (!years || !years.length) return "";
  const from = years[0];
  const to = years[years.length - 1];
  return from === to ? `${from}` : `${from}–${to}`;
}

/** bodyId -> () => void: a card that starts COLLAPSED renders its DOM
 * immediately but defers building its Chart.js instance(s) until the user
 * actually opens it — a chart built while its parent has the `hidden`
 * attribute gets stuck at zero size (Chart.js's own known "created while
 * hidden" issue), so building lazily on first expand is the fix, not just
 * an optimization. Cleared by destroyBasinCharts() on every full re-render. */
const hydroLazyChartBuilders = new Map();
/** canvas id -> { kind: "unit"|"pooled", r, pooled }: which river-unit (or
 * pooled analysis) a given chart's expand button belongs to, so clicking it
 * can open that WHOLE card's content (openHydroUnitModal/openHydroPooledModal)
 * in the shared modal — populated at wire time regardless of whether the
 * chart itself was built immediately or deferred. */
const hydroChartRegistry = new Map();

function hydroChartExpandButtonHtml(canvasId) {
  return `<button type="button" class="hydro-chart-expand-btn" data-expand-chart="${canvasId}" title="Expand graph" aria-label="Expand graph">⤢</button>`;
}

/** Short, collapsible "How to read this" block — replaces the old always-
 * visible dense gray "Period average = ..." paragraph with the same
 * collapsed-by-default pattern as the stats table, three plain-language
 * bullets instead of one dense sentence. */
function buildHydroReadingGuideHtml() {
  return `
    <details class="hydro-stats-details hydro-reading-guide">
      <summary>How to read this</summary>
      <ul class="hydro-reading-guide-list">
        <li>Each line shows how far above or below its own usual level something was that year.</li>
        <li>The shaded band is the normal range — anything outside it was an unusual year.</li>
        <li>A link means two things tended to move together across years. It never proves one causes the other — a wet year can move both at once.</li>
      </ul>
    </details>
  `;
}

/** The amber transboundary-catchment pill+text, shared by the inline card
 * header and the expand modal's sticky header. "" if there's no caveat. */
function buildCaveatBadgeHtml(caveatText) {
  return caveatText
    ? `<div class="hydro-caveat-badge"><span class="hydro-caveat-pill">⚠ Transboundary catchment</span><span class="hydro-caveat-badge-text">${caveatText}</span></div>`
    : "";
}

/** Title/subtitle for a river-unit's header, used by both the inline card
 * and the modal. The title always reads "{basin} basin" -- some basins (e.g.
 * Mūša) have two river units inside them, one where the river shares the
 * basin's name and one where it doesn't, and dropping "basin" whenever they
 * matched used to make one card read "Mūša" and its sibling "Mūša basin",
 * which looked like two different places rather than the same basin's two
 * gauges. Always including "basin" removes that ambiguity everywhere this
 * title appears, not just where two units happen to sit side by side. The
 * river is folded into the subtitle only when it's a different name than
 * the basin -- otherwise it's implied by the title already. */
function buildHydroUnitHeaderParts(r) {
  const years = r.correlation?.years_used || [];
  const yearSpan = years.length ? `${years[0]}–${years[years.length - 1]}` : "";
  const metricLabel = r.hydro_metric === "discharge" ? "discharge" : "water level";
  const riverPart = r.basin === r.river ? "" : `${r.river} river · `;
  return {
    title: `${r.basin} basin`,
    // station_name already ends in "gauging station" (translated from the
    // source data's Lithuanian "VMS" -- see translateStationName) so no
    // extra " station" is appended here; that used to read "... VMS
    // station", mixing languages in one redundant phrase.
    subtitle: `${riverPart}${r.station_name}${yearSpan ? ` · ${yearSpan}` : ""} · ${metricLabel}`,
  };
}

/** The simple side-by-side view used in place of the full correlation body
 * while SHOW_HYDRO_CORRELATION is off: land cover on the left, discharge/
 * level on the right, no takeaway/verdicts/stats/correlation of any kind.
 * Every basin card is a compact click-to-open tile now (see
 * buildUnitCardHtml) so this only ever renders inside the modal -- hence
 * the fixed ids/canvas-wrap class, no canvasPrefix/idx needed. Each chart
 * gets its own expand button (same .hydro-chart-expand-btn used elsewhere)
 * that makes just that one fill the row -- see wireRawCompareExpandToggle. */
function buildRawCompareHtml() {
  return `
    <div class="hydro-modal-chart-row hydro-raw-compare-row" id="hydro-raw-compare-row">
      <div class="hydro-raw-compare-col" data-raw-compare-col="lc">
        <h5 class="hydro-chart-label">Land cover</h5>
        <div class="hydro-modal-chart-wrap">
          <button type="button" class="hydro-chart-expand-btn" data-raw-expand="lc" title="Expand graph" aria-label="Expand graph">⤢</button>
          <canvas id="hydro-modal-unit-lc-0" role="img"></canvas>
        </div>
      </div>
      <div class="hydro-raw-compare-col" data-raw-compare-col="hy">
        <h5 class="hydro-chart-label">Water discharge</h5>
        <div class="hydro-modal-chart-wrap">
          <button type="button" class="hydro-chart-expand-btn" data-raw-expand="hy" title="Expand graph" aria-label="Expand graph">⤢</button>
          <canvas id="hydro-modal-unit-hy-0" role="img"></canvas>
        </div>
      </div>
    </div>
  `;
}

/** Wires the two per-chart expand buttons in buildRawCompareHtml's output:
 * clicking one hides the sibling column and lets that chart fill the row
 * (via the hydro-raw-compare-row--focus-* CSS classes); clicking the same
 * button again (now showing "show both") returns to side-by-side. Chart.js
 * doesn't repaint on a CSS-driven container resize by itself, so each
 * toggle calls .resize() on every open modal chart on the next frame (after
 * the CSS class change has actually reflowed the layout). */
function wireRawCompareExpandToggle() {
  const row = document.getElementById("hydro-raw-compare-row");
  if (!row) return;
  row.querySelectorAll("[data-raw-expand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.dataset.rawExpand;
      const alreadyFocused = row.classList.contains(`hydro-raw-compare-row--focus-${which}`);
      row.classList.remove("hydro-raw-compare-row--focus-lc", "hydro-raw-compare-row--focus-hy");
      row.querySelectorAll("[data-raw-expand]").forEach((b) => {
        b.textContent = "⤢";
        b.title = "Expand graph";
        b.setAttribute("aria-label", "Expand graph");
      });
      if (!alreadyFocused) {
        row.classList.add(`hydro-raw-compare-row--focus-${which}`);
        btn.textContent = "⤡";
        btn.title = "Show both graphs";
        btn.setAttribute("aria-label", "Show both graphs");
      }
      requestAnimationFrame(() => hydroExpandModalCharts.forEach((c) => c.resize()));
    });
  });
}

/** Shared card renderer for one river-unit, used by the overview, the
 * single-basin view, and each basin's group inside the multi-basin view.
 * `detailed=false` shows just the historical chart (the overview's compact
 * form); `detailed=true` adds the selected-year chart + its own conclusion
 * + the "period average" explainer. `startExpanded` controls whether the
 * card opens showing its full body (charts/tables/conclusion) or just its
 * headline (title, station, any caveat) — collapsed by default wherever a
 * card is one of many (the all-basins overview, each basin's group in the
 * multi-basin view) so scanning doesn't mean scrolling past every chart;
 * expanded by default wherever a card IS the thing the user asked to see
 * (the single-basin view). Same collapsible pattern as "About this
 * analysis" — an arrow that rotates, aria-expanded kept in sync. */
function buildUnitCardHtml(r, idx, canvasPrefix, detailed, startExpanded) {
  const { title, subtitle } = buildHydroUnitHeaderParts(r);
  const caveatHtml = buildCaveatBadgeHtml(r.catchment_caveat);
  const geometryNoteHtml = r.geometry_note
    ? `<p class="hydro-basin-card-sub">Note: ${r.geometry_note}.</p>`
    : "";
  if (r.error) {
    return `<div class="hydro-basin-card"><div class="hydro-basin-card-title">${title}</div><p class="hydro-basin-card-takeaway">Skipped: ${r.error}</p></div>`;
  }

  // SHOW_HYDRO_CORRELATION off: every card is the same compact click-to-open
  // tile regardless of startExpanded -- the single-basin view used to show
  // its graphs inline immediately (cramped into the sidebar's width, which
  // is also what caused the chart-overflow rendering glitch), but the ask
  // is "tile stays a tile, graphs only appear once you click it," same as
  // the overview list already did. Clicking opens openHydroUnitModal, which
  // has the room for the 2 charts side by side (and its own per-chart
  // expand toggle -- see buildRawCompareHtml/wireRawCompareExpandToggle).
  if (!SHOW_HYDRO_CORRELATION) {
    return `
      <div class="hydro-basin-card hydro-basin-card-compact" data-basin-card-station="${r.station_code}" data-open-modal="unit" role="button" tabindex="0" aria-label="${title} — open full details">
        <div class="hydro-basin-card-title-row">
          <span class="hydro-basin-card-title">${title}</span>
          <svg class="hydro-card-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        </div>
        <div class="hydro-basin-card-sub">${subtitle}</div>
        ${caveatHtml}
        ${geometryNoteHtml}
      </div>
    `;
  }

  const n = r.correlation?.n ?? 0;
  if (n < 3) {
    return `
      <div class="hydro-basin-card" data-basin-card-station="${r.station_code}">
        <div class="hydro-basin-card-title">${title}</div>
        <div class="hydro-basin-card-sub">${subtitle}</div>
        ${caveatHtml}
        <p class="hydro-basin-card-takeaway">Only ${n} overlapping year${n === 1 ? "" : "s"} of usable data at this station — not enough to check for a link.</p>
      </div>
    `;
  }

  // Collapsed-by-default cards (the all-basins overview, each basin's group
  // in the multi-basin view) render ONLY the scannable header -- station,
  // any caveat, and a 2-line-clamped takeaway sentence, no charts or tables
  // at all. Clicking anywhere on the card (or pressing Enter/Space while
  // it's focused) opens the full modal for that unit -- see
  // setupHydroCardToggles' [data-open-modal="unit"] handling -- instead of
  // expanding inline, so full detail lives in exactly one place and
  // scanning many basins never means scrolling past every chart (F2/F3).
  if (!startExpanded) {
    return `
      <div class="hydro-basin-card hydro-basin-card-compact" data-basin-card-station="${r.station_code}" data-open-modal="unit" role="button" tabindex="0" aria-label="${title} — open full details">
        <div class="hydro-basin-card-title-row">
          <span class="hydro-basin-card-title">${title}</span>
          <svg class="hydro-card-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        </div>
        <div class="hydro-basin-card-sub">${subtitle}</div>
        ${caveatHtml}
        ${geometryNoteHtml}
        <p class="hydro-card-takeaway">${buildHydroTakeawaySentence(r)}</p>
      </div>
    `;
  }

  const bodyId = `hydro-card-body-${canvasPrefix}-${idx}`;
  const statsHtml = buildStatsTableHtml(r.correlation.per_class);
  const metricLabel = r.hydro_metric === "discharge" ? "discharge" : "water level";
  const takeawayHtml = buildHydroTakeawayHtml(r);
  const verdictCardsHtml = buildClassVerdictCardsHtml(r, metricLabel);
  const statsDetailsHtml = `<details class="hydro-stats-details"><summary>Show the statistics</summary>${statsHtml}</details>`;
  const footnoteHtml = `<p class="hydro-source-footnote">Land cover: Esri 10 m annual (2017–2025) · Hydrology: api.meteo.lt</p>`;
  const year = getViewingCalendarYear();
  const histId = `${canvasPrefix}-hist-${idx}`;
  const yearId = `${canvasPrefix}-year-${idx}`;

  const bodyInner = detailed
    ? `
      ${takeawayHtml}
      <h5 class="hydro-chart-label">Year by year · ${formatYearSpan(r.correlation.years_used)}</h5>
      <div class="hydro-chart-wrap">${hydroChartExpandButtonHtml(histId)}<canvas id="${histId}" role="img"></canvas></div>
      <p class="hydro-chart-caption">Click a name to hide or show its line. Faded lines = no clear link.</p>
      ${verdictCardsHtml}
      ${statsDetailsHtml}

      <h5 class="hydro-chart-label">How did ${year ?? "—"} compare?</h5>
      <div class="hydro-chart-wrap">${hydroChartExpandButtonHtml(yearId)}<canvas id="${yearId}" role="img"></canvas></div>
      <p class="hydro-chart-caption">0 = this station's usual level · shaded band = normal range · outside the band = unusual year.</p>
      <p class="hydro-basin-card-takeaway">${year != null ? buildSelectedYearConclusion(r, year) : "No year currently selected on the map."}</p>
      ${year != null ? buildSelectedYearPerClassHtml(r, year) : ""}
      ${buildHydroReadingGuideHtml()}
      ${footnoteHtml}
    `
    : `
      ${takeawayHtml}
      <div class="hydro-chart-wrap">${hydroChartExpandButtonHtml(histId)}<canvas id="${histId}" role="img"></canvas></div>
      <p class="hydro-chart-caption">Click a name to hide or show its line. Faded lines = no clear link.</p>
      ${verdictCardsHtml}
      ${statsDetailsHtml}
    `;

  // startExpanded is always true past this point (the collapsed/compact
  // form above returns early) -- this is the single-basin focused view,
  // where the card IS the thing the user asked to see, so it stays fully
  // inline (still collapsible back via its own toggle if wanted).
  return `
    <div class="hydro-basin-card" data-basin-card-station="${r.station_code}">
      <button type="button" class="hydro-card-toggle hydro-card-open" aria-expanded="true" aria-controls="${bodyId}">
        <svg class="hydro-card-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        <span class="hydro-basin-card-title">${title}</span>
      </button>
      <div class="hydro-basin-card-sub">${subtitle}</div>
      ${caveatHtml}
      ${geometryNoteHtml}
      <div class="hydro-card-body" id="${bodyId}">
        ${bodyInner}
      </div>
    </div>
  `;
}

/** Opens the full-card modal for one river-unit: the historical chart, the
 * selected-year chart (if the currently-viewed map year has data for this
 * unit), the stats table, and both conclusion sections — i.e. everything
 * the inline card shows, just bigger and on its own, rather than one
 * isolated chart. Charts render full-width with Chart.js's own default
 * tooltip box (see hydroAnnualChartOptions/buildSelectedYearChart's
 * `expanded` argument) — the side tooltip panel this used to route
 * through is retired; the native-value breakdown just moved into that same
 * tooltip box instead of a separate panel, still only shown here (not on
 * the inline card). Re-reads the current map year fresh at open time, so
 * the modal always matches what's actually on the map right now rather
 * than whatever year was selected when the card was drawn. */
function openHydroUnitModal(r) {
  const { title, subtitle } = buildHydroUnitHeaderParts(r);

  // SHOW_HYDRO_CORRELATION off: just the plain side-by-side comparison,
  // full-size in the modal -- no takeaway/verdicts/stats/year-picker, all of
  // which are correlation-derived (see buildUnitCardHtml's own early return
  // for the same flag).
  if (!SHOW_HYDRO_CORRELATION) {
    const footnoteHtml = `<p class="hydro-source-footnote">Land cover: Esri 10 m annual (2017–2025) · Hydrology: api.meteo.lt</p>`;
    const html = `${buildRawCompareHtml()}${footnoteHtml}`;
    const chartBuilders = [
      { canvasId: "hydro-modal-unit-lc-0", build: (canvas) => buildRawLandCoverChart(canvas, r) },
      { canvasId: "hydro-modal-unit-hy-0", build: (canvas) => buildRawHydroChart(canvas, r) },
    ];
    openHydroContentModal(title, html, chartBuilders, { subtitle, badgeHtml: buildCaveatBadgeHtml(r.catchment_caveat) });
    wireRawCompareExpandToggle();
    return;
  }

  const initialYear = getViewingCalendarYear();
  const metricLabel = r.hydro_metric === "discharge" ? "discharge" : "water level";
  const takeawayHtml = buildHydroTakeawayHtml(r);
  const verdictCardsHtml = buildClassVerdictCardsHtml(r, metricLabel);
  const statsDetailsHtml = `<details class="hydro-stats-details"><summary>Show the statistics</summary>${buildStatsTableHtml(r.correlation.per_class)}</details>`;
  const footnoteHtml = `<p class="hydro-source-footnote">Land cover: Esri 10 m annual (2017–2025) · Hydrology: api.meteo.lt</p>`;
  const histChartId = "hydro-modal-unit-hist-chart";

  let html = `
    ${takeawayHtml}
    <h5 class="hydro-chart-label">Year by year · ${formatYearSpan(r.correlation.years_used)}</h5>
    <div class="hydro-modal-chart-wrap"><canvas id="${histChartId}" role="img"></canvas></div>
    <p class="hydro-chart-caption">Click a name to hide or show its line. Faded lines = no clear link.</p>
    ${verdictCardsHtml}
    ${statsDetailsHtml}
  `;
  const chartBuilders = [{ canvasId: histChartId, build: (canvas) => buildHistoricalChart(canvas, r, true) }];

  // Every year with usable data at this station -- not just whichever year
  // the map happens to be on -- so the picker below can browse any of them
  // without leaving the modal. Falls back to the most recent usable year if
  // the map's current year isn't one of them.
  const yearChartId = "hydro-modal-unit-year-chart";
  const availableYears = r.correlation.years_used.filter((y) => r.hydro_annual[y] && r.land_cover_annual_pct[y]);
  const defaultYear = availableYears.length
    ? (availableYears.includes(initialYear) ? initialYear : availableYears[availableYears.length - 1])
    : null;

  if (defaultYear != null) {
    const yearOptions = availableYears
      .map((y) => `<option value="${y}"${y === defaultYear ? " selected" : ""}>${y}</option>`)
      .join("");
    html += `
      <div class="hydro-modal-year-header">
        <h5 class="hydro-chart-label" id="hydro-modal-year-label">How did ${defaultYear} compare?</h5>
        <label class="hydro-modal-year-picker">
          <button type="button" class="hydro-year-stepper-btn" id="hydro-modal-year-prev" aria-label="Previous year">◀</button>
          <select id="hydro-modal-year-select">${yearOptions}</select>
          <button type="button" class="hydro-year-stepper-btn" id="hydro-modal-year-next" aria-label="Next year">▶</button>
        </label>
      </div>
      <div class="hydro-modal-chart-wrap"><canvas id="${yearChartId}" role="img"></canvas></div>
      <p class="hydro-chart-caption">0 = this station's usual level · shaded band = normal range · outside the band = unusual year.</p>
      <p class="hydro-basin-card-takeaway" id="hydro-modal-year-conclusion">${buildSelectedYearConclusion(r, defaultYear)}</p>
      <div id="hydro-modal-year-perclass">${buildSelectedYearPerClassHtml(r, defaultYear)}</div>
      ${buildHydroReadingGuideHtml()}
    `;
    chartBuilders.push({ canvasId: yearChartId, build: (canvas) => buildSelectedYearChart(canvas, r, defaultYear, true) });
  } else if (initialYear == null) {
    html += `<p class="hydro-basin-card-takeaway">No year currently selected on the map.</p>`;
  } else {
    html += `<p class="hydro-basin-card-takeaway">No usable year-by-year data at this station.</p>`;
  }
  html += footnoteHtml;

  openHydroContentModal(title, html, chartBuilders, { subtitle, badgeHtml: buildCaveatBadgeHtml(r.catchment_caveat) });

  if (defaultYear != null) {
    const select = document.getElementById("hydro-modal-year-select");
    const prevBtn = document.getElementById("hydro-modal-year-prev");
    const nextBtn = document.getElementById("hydro-modal-year-next");
    const showYear = (y) => {
      const canvas = document.getElementById(yearChartId);
      if (!canvas) return;
      // Swap out just the year chart's Chart.js instance -- the historical
      // chart above stays untouched. Removed from hydroExpandModalCharts
      // before destroying so closing the modal later doesn't try to
      // destroy an already-destroyed instance.
      const oldIdx = hydroExpandModalCharts.findIndex((c) => c.canvas === canvas);
      if (oldIdx >= 0) {
        hydroExpandModalCharts[oldIdx].destroy();
        hydroExpandModalCharts.splice(oldIdx, 1);
      }
      hydroExpandModalCharts.push(buildSelectedYearChart(canvas, r, y, true));
      const label = document.getElementById("hydro-modal-year-label");
      if (label) label.textContent = `How did ${y} compare?`;
      const conclusion = document.getElementById("hydro-modal-year-conclusion");
      if (conclusion) conclusion.textContent = buildSelectedYearConclusion(r, y);
      const perClass = document.getElementById("hydro-modal-year-perclass");
      if (perClass) perClass.innerHTML = buildSelectedYearPerClassHtml(r, y);
      if (select) select.value = String(y);
      const idx = availableYears.indexOf(y);
      if (prevBtn) prevBtn.disabled = idx <= 0;
      if (nextBtn) nextBtn.disabled = idx === -1 || idx >= availableYears.length - 1;
    };
    select?.addEventListener("change", () => {
      const y = parseInt(select.value, 10);
      if (Number.isFinite(y)) showYear(y);
    });
    prevBtn?.addEventListener("click", () => {
      const idx = availableYears.indexOf(parseInt(select.value, 10));
      if (idx > 0) showYear(availableYears[idx - 1]);
    });
    nextBtn?.addEventListener("click", () => {
      const idx = availableYears.indexOf(parseInt(select.value, 10));
      if (idx >= 0 && idx < availableYears.length - 1) showYear(availableYears[idx + 1]);
    });
    const startIdx = availableYears.indexOf(defaultYear);
    if (prevBtn) prevBtn.disabled = startIdx <= 0;
    if (nextBtn) nextBtn.disabled = startIdx === -1 || startIdx >= availableYears.length - 1;
  }
}

/** Opens the full-card modal for the multi-basin pooled meta-analysis —
 * same idea as openHydroUnitModal, for the one pooled summary card. */
function openHydroPooledModal(pooled) {
  const chartId = "hydro-modal-pooled-chart";
  const title = `Combined: ${pooled.basinNames.join(" + ")} · ${pooled.k} gauges`;
  let html = `
    ${buildPooledTakeawayHtml(pooled)}
    <div class="hydro-modal-chart-wrap"><canvas id="${chartId}" role="img"></canvas></div>
    <p class="hydro-chart-caption">Click a name to hide or show its line. Faded lines = no clear link.</p>
    ${buildPooledVerdictCardsHtml(pooled)}
    <details class="hydro-stats-details"><summary>Show the statistics</summary>${buildPooledStatsTableHtml(pooled.perClassStats)}${buildPooledMethodDetailHtml()}</details>
  `;
  const chartBuilders = [{ canvasId: chartId, build: (canvas) => buildPooledChart(canvas, pooled) }];

  const yearChartId = "hydro-modal-pooled-year-chart";
  const initialYear = getViewingCalendarYear();
  const availableYears = pooled.years.filter((y) => pooled.hydro[y] != null);
  const defaultYear = availableYears.length
    ? (availableYears.includes(initialYear) ? initialYear : availableYears[availableYears.length - 1])
    : null;

  if (defaultYear != null) {
    const yearOptions = availableYears
      .map((y) => `<option value="${y}"${y === defaultYear ? " selected" : ""}>${y}</option>`)
      .join("");
    html += `
      <div class="hydro-modal-year-header">
        <h5 class="hydro-chart-label" id="hydro-modal-pooled-year-label">How did ${defaultYear} compare?</h5>
        <label class="hydro-modal-year-picker">
          <button type="button" class="hydro-year-stepper-btn" id="hydro-modal-pooled-year-prev" aria-label="Previous year">◀</button>
          <select id="hydro-modal-pooled-year-select">${yearOptions}</select>
          <button type="button" class="hydro-year-stepper-btn" id="hydro-modal-pooled-year-next" aria-label="Next year">▶</button>
        </label>
      </div>
      <div class="hydro-modal-chart-wrap"><canvas id="${yearChartId}" role="img"></canvas></div>
      <p class="hydro-chart-caption">0 = normal for the pooled gauges · shaded band = normal range · outside the band = unusual year.</p>
    `;
    chartBuilders.push({ canvasId: yearChartId, build: (canvas) => buildPooledSelectedYearChart(canvas, pooled, defaultYear) });
  }

  html += `<p class="hydro-source-footnote">Lines show the average across the selected gauges; the link verdicts are combined from each gauge's own history.</p>`;

  openHydroContentModal(title, html, chartBuilders);

  if (defaultYear != null) {
    const select = document.getElementById("hydro-modal-pooled-year-select");
    const prevBtn = document.getElementById("hydro-modal-pooled-year-prev");
    const nextBtn = document.getElementById("hydro-modal-pooled-year-next");
    const showYear = (y) => {
      const canvas = document.getElementById(yearChartId);
      if (!canvas) return;
      const oldIdx = hydroExpandModalCharts.findIndex((c) => c.canvas === canvas);
      if (oldIdx >= 0) {
        hydroExpandModalCharts[oldIdx].destroy();
        hydroExpandModalCharts.splice(oldIdx, 1);
      }
      hydroExpandModalCharts.push(buildPooledSelectedYearChart(canvas, pooled, y));
      const label = document.getElementById("hydro-modal-pooled-year-label");
      if (label) label.textContent = `How did ${y} compare?`;
      if (select) select.value = String(y);
      const idx = availableYears.indexOf(y);
      if (prevBtn) prevBtn.disabled = idx <= 0;
      if (nextBtn) nextBtn.disabled = idx === -1 || idx >= availableYears.length - 1;
    };
    select?.addEventListener("change", () => {
      const y = parseInt(select.value, 10);
      if (Number.isFinite(y)) showYear(y);
    });
    prevBtn?.addEventListener("click", () => {
      const idx = availableYears.indexOf(parseInt(select.value, 10));
      if (idx > 0) showYear(availableYears[idx - 1]);
    });
    nextBtn?.addEventListener("click", () => {
      const idx = availableYears.indexOf(parseInt(select.value, 10));
      if (idx >= 0 && idx < availableYears.length - 1) showYear(availableYears[idx + 1]);
    });
    const startIdx = availableYears.indexOf(defaultYear);
    if (prevBtn) prevBtn.disabled = startIdx <= 0;
    if (nextBtn) nextBtn.disabled = startIdx === -1 || startIdx >= availableYears.length - 1;
  }
}

function wireUnitCharts(r, idx, canvasPrefix, detailed, startExpanded) {
  if (r.error) return;
  // SHOW_HYDRO_CORRELATION off: every card is a compact tile now (see
  // buildUnitCardHtml) -- nothing inline to wire, openHydroUnitModal builds
  // its own two chart instances fresh when the tile is clicked.
  if (!SHOW_HYDRO_CORRELATION) return;
  if ((r.correlation?.n ?? 0) < 3) return;
  // Collapsed/compact cards (startExpanded=false) render no inline charts
  // at all any more -- see buildUnitCardHtml's early-return "compact" form
  // -- clicking one opens the modal directly, which builds its own charts
  // fresh from `r`. Nothing to wire here for that case.
  if (!startExpanded) return;
  const histId = `${canvasPrefix}-hist-${idx}`;
  const yearId = `${canvasPrefix}-year-${idx}`;
  const year = getViewingCalendarYear();
  // Both this unit's expand buttons open the SAME full-card modal (see
  // openHydroUnitModal) -- registered under both canvas ids so whichever
  // one the user actually clicked resolves to the identical destination.
  hydroChartRegistry.set(histId, { kind: "unit", r });
  if (detailed) hydroChartRegistry.set(yearId, { kind: "unit", r });

  const histCanvas = document.getElementById(histId);
  if (histCanvas) basinChartInstances.set(`${canvasPrefix}-${idx}-hist`, buildHistoricalChart(histCanvas, r));
  if (!detailed) return;
  const yearCanvas = document.getElementById(yearId);
  if (yearCanvas && year != null && r.hydro_annual[year] && r.land_cover_annual_pct[year]) {
    basinChartInstances.set(`${canvasPrefix}-${idx}-year`, buildSelectedYearChart(yearCanvas, r, year));
  }
}

/** Every basin name that actually has correlation data, deduped, in
 * first-seen order — the "all Lithuania" equivalent of the basin-name list
 * a multi-basin Filters selection would otherwise supply. */
function allBasinNames() {
  return [...new Set(basinCorrelationData.map((r) => r.basin))];
}

// detailed=true so the selected-year bar chart (previously only built for
// the single/multi-basin focused views) shows here too once a card is
// expanded -- startExpanded stays false so the 16-card overview still opens
// compact by default. A combined/averaged card across every basin closes
// out the list, same as the multi-basin-selection view already gets.
function renderBasinOverviewHtml() {
  const perBasinHtml = basinCorrelationData.map((r, idx) => buildUnitCardHtml(r, idx, "hydro-basin", true, false)).join("");
  // The cross-basin "Combined" pooled/meta-analysis section is entirely a
  // correlation feature (Fisher-z combined across gauges) -- no raw-graph
  // equivalent makes sense for a pool of basins, so it's skipped outright
  // rather than simplified, same as the flag gates everywhere else.
  if (!SHOW_HYDRO_CORRELATION) return perBasinHtml;
  const pooled = buildPooledAnalysis(allBasinNames());
  const pooledHtml = pooled
    ? renderPooledCardHtml(pooled)
    : `<p class="hydro-basin-card-takeaway">Not enough overlapping data across all basins to build a combined view.</p>`;
  return `${perBasinHtml}<hr class="hydro-section-sep"><h5 class="hydro-multi-basin-label">Combined (all Lithuania)</h5>${pooledHtml}`;
}
function wireBasinOverviewCharts() {
  basinCorrelationData.forEach((r, idx) => wireUnitCharts(r, idx, "hydro-basin", true, false));
  if (!SHOW_HYDRO_CORRELATION) return;
  wirePooledCharts(buildPooledAnalysis(allBasinNames()));
}

function renderSingleBasinHtml(basinName) {
  const units = basinCorrelationData.filter((r) => r.basin === basinName);
  const header = `
    <div class="hydro-focused-header">
      <div class="hydro-basin-card-title">${basinName} basin</div>
      <p class="hydro-focused-hint">Select "All Lithuania" or a different set of basins in Filters and click Apply Filters to change this.</p>
    </div>
  `;
  const cards = units.map((r, idx) => buildUnitCardHtml(r, idx, "hydro-single", true, true)).join("");
  return header + cards;
}
function wireSingleBasinCharts(basinName) {
  basinCorrelationData.filter((r) => r.basin === basinName).forEach((r, idx) => wireUnitCharts(r, idx, "hydro-single", true, true));
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 rational
 * approximation of erf (max error ~1.5e-7) — everything pooledCorrelationMeta
 * needs to turn a z-statistic into a p-value, without pulling in a stats
 * library for one function. */
function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + Math.sign(x) * erf);
}

/** Fisher-z meta-analysis of ALREADY-COMPUTED per-unit correlations (each
 * gauge's own Pearson/Spearman r, precomputed server-side from its full
 * year series — see basin_hydrology_correlation.py) for one land-cover
 * class, across whichever river-units belong to the selected basins. This
 * is the standard fixed-effect meta-analytic combination: each unit's r is
 * Fisher-z transformed (atanh), weighted by its own precision (n-3 for
 * Pearson; n-3 divided by 1.06 for Spearman, since a rank correlation's
 * sampling variance runs about 6% higher than Pearson's at the same n --
 * Fieller, Hartley & Pearson 1957), averaged in z-space, then transformed
 * back (tanh) — NOT a re-correlation of an averaged series, which would
 * throw away each gauge's own precision and manufacture a single series out
 * of basins that may not physically belong together. Returns null if fewer
 * than 2 units have a usable r at n>=4 (Fisher-z's variance, 1/(n-3), is
 * undefined below that). */
function pooledCorrelationMeta(units, cls, which) {
  const varFac = which === "spearman" ? 1.06 : 1.0;
  let W = 0, Z = 0, k = 0;
  for (const u of units) {
    const s = u.correlation?.per_class?.[cls];
    const r = s?.[`${which}_r`];
    const n = u.correlation?.n;
    if (r == null || !Number.isFinite(r) || !(n >= 4)) continue;
    const rc = Math.max(-0.999999, Math.min(0.999999, r));
    const w = (n - 3) / varFac;
    W += w;
    Z += w * Math.atanh(rc);
    k += 1;
  }
  if (k < 2) return null;
  const zbar = Z / W;
  const se = 1 / Math.sqrt(W);
  return {
    r: Math.tanh(zbar),
    lo: Math.tanh(zbar - 1.96 * se),
    hi: Math.tanh(zbar + 1.96 * se),
    p: 2 * (1 - normCdf(Math.abs(zbar) / se)),
    k,
  };
}

/** Gathers the river-units belonging to the selected basins and builds: (1)
 * per-class Fisher-z meta-analytic Pearson/Spearman statistics (the real
 * combined result, from each gauge's own precomputed correlation — see
 * pooledCorrelationMeta), and (2) a simple visual-only composite chart
 * series (the per-year arithmetic mean of the selected units' own z-score
 * series, nulls dropped) so there's still something to look at year by
 * year — that composite is NOT what the statistics table is computed from.
 * `allYears` is derived only from the units actually being pooled here, not
 * every river-unit in the dataset. Returns null if fewer than 2 usable
 * units are selected. */
function buildPooledAnalysis(basinNames) {
  const units = basinCorrelationData.filter((r) => basinNames.includes(r.basin) && !r.error && (r.correlation?.n ?? 0) >= 3);
  if (units.length < 2) return null;

  const allYears = [...new Set(units.flatMap((r) => r.correlation.years_used))].sort((a, b) => a - b);
  const unitZ = units.map(zScoreSeriesForUnit);

  const chartHydro = {};
  const chartClasses = {};
  Object.keys(HYDRO_CLASS_COLORS).forEach((cls) => { chartClasses[cls] = {}; });
  allYears.forEach((y) => {
    chartHydro[y] = average(unitZ.map((s) => s.hydro[y]));
    Object.keys(HYDRO_CLASS_COLORS).forEach((cls) => { chartClasses[cls][y] = average(unitZ.map((s) => s.classes[cls]?.[y])); });
  });

  const perClassStats = {};
  Object.keys(HYDRO_CLASS_COLORS).forEach((cls) => {
    perClassStats[cls] = {
      spearman: pooledCorrelationMeta(units, cls, "spearman"),
      pearson: pooledCorrelationMeta(units, cls, "pearson"),
    };
  });

  return {
    basinNames: [...new Set(units.map((u) => u.basin))],
    k: units.length,
    years: allYears,
    hydro: chartHydro,
    classes: chartClasses,
    perClassStats,
  };
}

/** Visual-composite-only chart: mean z-score across the pooled gauges, year
 * by year — NOT the source of the pooled table's statistics (see
 * buildPooledAnalysis's own doc comment). No native-value tooltip here,
 * unlike the per-unit historical chart: a mean across gauges that may mix
 * discharge (m³/s) and water level (cm) has no single coherent "actual"
 * value to show. */
function buildPooledChart(canvas, pooled) {
  const years = buildContinuousYearRange(pooled.years);
  const datasets = [
    {
      label: `Mean across ${pooled.k} gauges`,
      data: years.map((y) => pooled.hydro[y] ?? null),
      borderColor: "#0f172a",
      backgroundColor: "#0f172a",
      pointBackgroundColor: "#0f172a",
      tension: 0,
      pointRadius: 3,
      spanGaps: false,
      borderWidth: 2.5,
    },
    ...Object.entries(HYDRO_CLASS_COLORS).map(([cls, color]) => {
      const absR = pooled.perClassStats?.[cls]?.spearman?.r != null ? Math.abs(pooled.perClassStats[cls].spearman.r) : null;
      const faded = !isNotableR(absR);
      const drawColor = faded ? withAlpha(color, 0.25) : color;
      return {
        label: cls,
        data: years.map((y) => pooled.classes[cls][y] ?? null),
        borderColor: drawColor,
        backgroundColor: drawColor,
        pointBackgroundColor: drawColor,
        faded,
        tension: 0,
        pointRadius: 3,
        spanGaps: false,
      };
    }),
  ];
  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: years, datasets },
    options: hydroAnnualChartOptions("vs. a typical year", false, false),
    plugins: [typicalBandPlugin],
  });
  canvas.setAttribute("aria-label", `Mean standardized departure across ${pooled.k} pooled gauges, ${pooled.basinNames.join(", ")}, ${years[0]}–${years[years.length - 1]}`);
  return chart;
}

/** Diverging bar chart for the pooled meta-analysis — the same "one selected
 * year, every class side by side" view buildSelectedYearChart gives a single
 * river-unit, applied to the pooled composite series instead (pooled.hydro/
 * pooled.classes are already an average of z-scores across gauges, so this
 * chart's bars ARE the mean-σ visual composite for that one year). No
 * native-value tooltip line here, same reasoning as buildPooledChart: a
 * mean across gauges that may mix discharge and water level has no single
 * coherent "actual" reading to show. Reference bar (mean flow) first, same
 * bold-tick/outline/divider treatment as buildSelectedYearChart. */
function buildPooledSelectedYearChart(canvas, pooled, year) {
  const classes = Object.keys(HYDRO_CLASS_COLORS);
  const labels = ["Mean flow", ...classes];
  const vals = [pooled.hydro[year] ?? null, ...classes.map((c) => pooled.classes[c]?.[year] ?? null)];
  const colors = vals.map((v) => (v == null ? "#cbd5e1" : v >= 0 ? "#16a34a" : "#dc2626"));
  const borderColors = vals.map((_, i) => (i === 0 ? "#0f172a" : "transparent"));
  const borderWidths = vals.map((_, i) => (i === 0 ? 2 : 0));
  const finiteVals = vals.filter((v) => v != null && Number.isFinite(v));
  const maxAbs = finiteVals.length ? Math.max(...finiteVals.map(Math.abs), 0.5) : 1;
  const barCallbacks = { label: (ctx) => `${ctx.label}: ${ctx.parsed.y == null ? "—" : ctx.parsed.y.toFixed(2)}σ` };
  const chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets: [{ label: `${year} — mean σ across pooled gauges`, data: vals, backgroundColor: colors, borderColor: borderColors, borderWidth: borderWidths }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: barCallbacks },
      },
      scales: {
        x: { ticks: { font: (ctx) => ({ size: 11, weight: ctx.index === 0 ? "bold" : "normal" }) } },
        y: {
          suggestedMin: -maxAbs,
          suggestedMax: maxAbs,
          title: { display: true, text: "vs. a typical year" },
          ticks: { font: { size: 11 } },
          grid: {
            color: (ctx) => (ctx.tick.value === 0 ? "#94a3b8" : "#e5e7eb"),
            lineWidth: (ctx) => (ctx.tick.value === 0 ? 2 : 1),
          },
        },
      },
    },
    plugins: [typicalBandPlugin, barDividerPlugin],
  });
  canvas.setAttribute("aria-label", `${year} mean standardized departure by land-cover class, pooled across ${pooled.k} gauges`);
  return chart;
}

/** Spearman-only meta-analytic table: ρ, its 95% range, p, and how many
 * gauges contributed, per class — Spearman is the headline statistic the
 * verdicts are actually based on (see pooledVerdictTier), so the details
 * table shows just that one family rather than duplicating the per-basin
 * table's Spearman+Pearson layout for a number nothing else here uses. */
function buildPooledStatsTableHtml(perClassStats) {
  const fmtP = (m) => (m ? (m.p < 0.001 ? "<0.001" : m.p.toFixed(3)) : "—");
  const entries = Object.entries(perClassStats || {}).sort((a, b) => {
    const aAbs = a[1]?.spearman?.r != null ? Math.abs(a[1].spearman.r) : -1;
    const bAbs = b[1]?.spearman?.r != null ? Math.abs(b[1].spearman.r) : -1;
    return bAbs - aAbs;
  });
  const rows = entries
    .map(([cls, s]) => {
      const m = s.spearman;
      if (!m) return `<tr><td>${cls}</td><td colspan="4" class="hydro-stats-na">fewer than 2 gauges with a usable correlation</td></tr>`;
      const t = pooledVerdictTier(m);
      const verdictWord = t.tier === "CLEAR" ? "Clear link" : t.tier === "POSSIBLE" ? "Possible link" : "No link";
      return `
        <tr>
          <td>${cls}</td>
          <td class="num">${fmtCorrNum(m.r, 2)}</td>
          <td class="num">[${fmtCorrNum(m.lo, 2)}, ${fmtCorrNum(m.hi, 2)}]</td>
          <td class="num">${fmtP(m)}</td>
          <td class="num">${m.k}</td>
          <td>${verdictWord}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="hydro-table-scroll">
      <table class="hydro-stats-table">
        <caption class="visually-hidden">Combined correlation statistics for each land-cover class across the selected gauges</caption>
        <thead><tr>
          <th scope="col">Class</th>
          <th class="num" scope="col" title="Rank correlation, −1 to +1 — combined across the selected gauges (the verdicts use this one)">ρ</th>
          <th class="num" scope="col" title="The plausible range for the combined value.">95% range</th>
          <th class="num" scope="col">p</th>
          <th scope="col">gauges</th>
          <th scope="col">Verdict</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/** The full Fisher-z methodology paragraph, moved inside "Show the
 * statistics" (see A6) — visible only when a reader deliberately opens the
 * details layer, under its own bold sub-heading. */
function buildPooledMethodDetailHtml() {
  return `<p class="hydro-pooled-method-detail"><strong>How the combined numbers are made</strong><br>Each gauge's own Spearman/Pearson correlation (computed once, server-side, from its full year series) is combined by Fisher-z meta-analysis — a precision-weighted average in z-space, not a re-correlation of an averaged series. Both charts above are a visual composite only (mean across the pooled gauges, over time and for one selected year) — neither is what the table's statistics come from.</p>`;
}

function renderPooledCardHtml(pooled) {
  const year = getViewingCalendarYear();
  const availableYears = pooled.years.filter((y) => pooled.hydro[y] != null);
  const barYear = availableYears.length
    ? (availableYears.includes(year) ? year : availableYears[availableYears.length - 1])
    : null;
  const barSection = barYear != null
    ? `
      <div class="hydro-modal-year-header">
        <h5 class="hydro-chart-label" id="hydro-pooled-year-label">How did ${barYear} compare?</h5>
        <label class="hydro-modal-year-picker">
          <button type="button" class="hydro-year-stepper-btn" id="hydro-pooled-year-prev" aria-label="Previous year">◀</button>
          <select id="hydro-pooled-year-select">${availableYears.map((y) => `<option value="${y}"${y === barYear ? " selected" : ""}>${y}</option>`).join("")}</select>
          <button type="button" class="hydro-year-stepper-btn" id="hydro-pooled-year-next" aria-label="Next year">▶</button>
        </label>
      </div>
      <div class="hydro-chart-wrap">${hydroChartExpandButtonHtml("hydro-pooled-year-chart")}<canvas id="hydro-pooled-year-chart" role="img"></canvas></div>
      <p class="hydro-chart-caption">0 = normal for the pooled gauges · shaded band = normal range.</p>
    `
    : "";
  return `
    <div class="hydro-basin-card hydro-pooled-card">
      <div class="hydro-basin-card-sub">Combined: ${pooled.basinNames.join(" + ")} · ${pooled.k} gauges</div>
      ${buildPooledTakeawayHtml(pooled)}
      <div class="hydro-chart-wrap">${hydroChartExpandButtonHtml("hydro-pooled-chart")}<canvas id="hydro-pooled-chart" role="img"></canvas></div>
      <p class="hydro-chart-caption">Click a name to hide or show its line. Faded lines = no clear link.</p>
      ${buildPooledVerdictCardsHtml(pooled)}
      <details class="hydro-stats-details"><summary>Show the statistics</summary>${buildPooledStatsTableHtml(pooled.perClassStats)}${buildPooledMethodDetailHtml()}</details>
      ${barSection}
      <p class="hydro-source-footnote">Lines show the average across the selected gauges; the link verdicts are combined from each gauge's own history.</p>
    </div>
  `;
}

function renderMultiBasinHtml(basinNames) {
  // The explanatory paragraph that used to sit here every render now lives
  // once in "About this analysis" instead (F5) -- it doesn't change per
  // selection, so repeating it on every render just pushed the actual
  // basin list further down.
  const header = `
    <div class="hydro-focused-header">
      <div class="hydro-multi-basin-count">${basinNames.length} basins selected</div>
    </div>
  `;
  // detailed=true so the selected-year chart (previously only shown in the
  // single-basin view) renders here too -- it was silently missing before
  // because this passed detailed=false, which buildUnitCardHtml treats as
  // "historical chart only". startExpanded=false keeps things compact by
  // default when several basins (each with 1-2 units) are stacked at once.
  const perBasinHtml = basinNames
    .map((bn, bIdx) => {
      const units = basinCorrelationData.filter((r) => r.basin === bn);
      const unitCards = units.map((r, uIdx) => buildUnitCardHtml(r, `${bIdx}-${uIdx}`, "hydro-multi", true, false)).join("");
      // A group label above the card(s) is only useful when there's more
      // than one unit to label as siblings -- with exactly one, the card's
      // own header already names the basin, so the label above it would
      // just be the same name twice (F1).
      const groupLabel = units.length > 1 ? `<h5 class="hydro-multi-basin-label">${bn} basin</h5>` : "";
      return `<div class="hydro-multi-basin-group">${groupLabel}${unitCards}</div>`;
    })
    .join("");

  // See renderBasinOverviewHtml's own comment -- the pooled/meta-analysis
  // section is correlation-only and has no raw-graph equivalent, so it's
  // skipped entirely while SHOW_HYDRO_CORRELATION is off.
  if (!SHOW_HYDRO_CORRELATION) return `${header}${perBasinHtml}`;

  const pooled = buildPooledAnalysis(basinNames);
  const pooledHtml = pooled
    ? renderPooledCardHtml(pooled)
    : `<p class="hydro-basin-card-takeaway">Not enough overlapping data across the selected basins to build a combined view.</p>`;

  return `${header}${perBasinHtml}<hr class="hydro-section-sep"><h5 class="hydro-multi-basin-label">Combined (${basinNames.length} basins averaged)</h5>${pooledHtml}`;
}

/** Builds the pooled composite chart(s) + registers the expand button +
 * wires the inline ◀ select ▶ year stepper for a combined/pooled card
 * that's already in the DOM (id="hydro-pooled-chart"/"hydro-pooled-year-*")
 * -- shared by the multi-basin-selection view and the all-Lithuania
 * overview, which both end with the exact same combined card and need the
 * exact same wiring. */
function wirePooledCharts(pooled) {
  if (!pooled) return;
  hydroChartRegistry.set("hydro-pooled-chart", { kind: "pooled", pooled });
  const canvas = document.getElementById("hydro-pooled-chart");
  if (canvas) basinChartInstances.set("pooled", buildPooledChart(canvas, pooled));

  const year = getViewingCalendarYear();
  const availableYears = pooled.years.filter((y) => pooled.hydro[y] != null);
  const barYear = availableYears.length
    ? (availableYears.includes(year) ? year : availableYears[availableYears.length - 1])
    : null;
  if (barYear == null) return;
  hydroChartRegistry.set("hydro-pooled-year-chart", { kind: "pooled", pooled });
  const yearCanvas = document.getElementById("hydro-pooled-year-chart");
  if (yearCanvas) basinChartInstances.set("pooled-year", buildPooledSelectedYearChart(yearCanvas, pooled, barYear));

  // Same ◀ select ▶ stepper as the modal (A7), scoped to this inline
  // card's own canvas/label instead of the modal's -- lets a reader
  // browse other years without moving the map's own slider.
  const select = document.getElementById("hydro-pooled-year-select");
  const prevBtn = document.getElementById("hydro-pooled-year-prev");
  const nextBtn = document.getElementById("hydro-pooled-year-next");
  const showPooledYear = (y) => {
    const canvas2 = document.getElementById("hydro-pooled-year-chart");
    if (!canvas2) return;
    basinChartInstances.get("pooled-year")?.destroy();
    basinChartInstances.set("pooled-year", buildPooledSelectedYearChart(canvas2, pooled, y));
    const label = document.getElementById("hydro-pooled-year-label");
    if (label) label.textContent = `How did ${y} compare?`;
    if (select) select.value = String(y);
    const idx = availableYears.indexOf(y);
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx === -1 || idx >= availableYears.length - 1;
  };
  select?.addEventListener("change", () => {
    const y = parseInt(select.value, 10);
    if (Number.isFinite(y)) showPooledYear(y);
  });
  prevBtn?.addEventListener("click", () => {
    const idx = availableYears.indexOf(parseInt(select.value, 10));
    if (idx > 0) showPooledYear(availableYears[idx - 1]);
  });
  nextBtn?.addEventListener("click", () => {
    const idx = availableYears.indexOf(parseInt(select.value, 10));
    if (idx >= 0 && idx < availableYears.length - 1) showPooledYear(availableYears[idx + 1]);
  });
  const startIdx = availableYears.indexOf(barYear);
  if (prevBtn) prevBtn.disabled = startIdx <= 0;
  if (nextBtn) nextBtn.disabled = startIdx === -1 || startIdx >= availableYears.length - 1;
}

function wireMultiBasinCharts(basinNames) {
  basinNames.forEach((bn, bIdx) => {
    basinCorrelationData.filter((r) => r.basin === bn).forEach((r, uIdx) => wireUnitCharts(r, `${bIdx}-${uIdx}`, "hydro-multi", true, false));
  });
  if (!SHOW_HYDRO_CORRELATION) return;
  wirePooledCharts(buildPooledAnalysis(basinNames));
}

/** basinCorrelationData/basinRiversGeoJson are keyed by basin — focusedBasinNames
 * (set in enterHydrologyMapMode from the Filters panel's own basin checkboxes,
 * see getFocusedBasinNamesFromFilters) decides whether this shows every
 * basin, one basin in full detail, or several basins separately plus a
 * combined view, on both the sidebar and the map. */
function renderBasinHydrologySidebar() {
  const listEl = document.getElementById("hydro-basin-list");
  if (!listEl) return;
  destroyBasinCharts();
  try {
    if (!focusedBasinNames || !focusedBasinNames.length) {
      listEl.innerHTML = renderBasinOverviewHtml();
      wireBasinOverviewCharts();
    } else if (focusedBasinNames.length === 1) {
      listEl.innerHTML = renderSingleBasinHtml(focusedBasinNames[0]);
      wireSingleBasinCharts(focusedBasinNames[0]);
    } else {
      listEl.innerHTML = renderMultiBasinHtml(focusedBasinNames);
      wireMultiBasinCharts(focusedBasinNames);
    }
  } catch (e) {
    // A thrown error here previously left the LAST successfully-rendered
    // HTML sitting stale (assignment to .innerHTML never happens if the
    // right-hand side throws first) -- silently looking like "the basins I
    // just selected just don't show up" with zero indication anything went
    // wrong. Surface it instead.
    console.error("[hydro] failed to render basin sidebar for", focusedBasinNames, e);
    renderHydroErrorState(() => renderBasinHydrologySidebar());
  }
}

/** Re-renders the single-basin view's "selected year" section live as the
 * map's own year slider moves, so it always reflects "the year we are
 * viewing" (the overview and multi-basin views don't show a selected-year
 * section, so there's nothing to refresh for those). */
/** Which cards are currently expanded, by body id -- captured before a
 * slider-triggered re-render so the rebuild (which reconstructs every card
 * from its view's own default expand state) doesn't silently re-collapse
 * something the user deliberately opened. */
function captureHydroCardExpandState() {
  const listEl = document.getElementById("hydro-basin-list");
  if (!listEl) return new Set();
  return new Set(
    Array.from(listEl.querySelectorAll(".hydro-card-toggle[aria-expanded='true']"))
      .map((btn) => btn.getAttribute("aria-controls")),
  );
}

function restoreHydroCardExpandState(expandedIds) {
  expandedIds.forEach((bodyId) => {
    const body = document.getElementById(bodyId);
    if (!body || !body.hidden) return; // gone, or already open by default in the new render
    const toggleBtn = document.querySelector(`.hydro-card-toggle[aria-controls="${bodyId}"]`);
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-expanded", "true");
    toggleBtn.classList.add("hydro-card-open");
    body.hidden = false;
    const builder = hydroLazyChartBuilders.get(bodyId);
    if (builder) {
      hydroLazyChartBuilders.delete(bodyId);
      requestAnimationFrame(() => builder()); // same hidden-parent-sizing reasoning as setupHydroCardToggles
    }
  });
}

/** Re-renders the sidebar live as the map's own year slider moves, so the
 * "selected year" chart/conclusion (shown for a single focused basin, AND
 * for each unit inside a multi-basin comparison) always reflects "the year
 * we are viewing" rather than whatever year was selected when the card was
 * first drawn. The all-basins overview never shows a selected-year section
 * (its cards are the compact historical-only form), so there's nothing to
 * refresh there. Card expand/collapse state survives the rebuild via
 * capture/restoreHydroCardExpandState. */
function setupHydrologyYearSliderHook() {
  const yearSlider = document.getElementById("year-slider");
  if (yearSlider && !yearSlider.dataset.hydroFocusBound) {
    yearSlider.dataset.hydroFocusBound = "1";
    yearSlider.addEventListener("input", () => {
      if (!focusedBasinNames || !focusedBasinNames.length) return;
      const expandedIds = captureHydroCardExpandState();
      renderBasinHydrologySidebar();
      restoreHydroCardExpandState(expandedIds);
    });
  }
}

/** Collapsible "About" section (arrow + heading, collapsed by default) —
 * replaces what used to be always-visible intro text. */
/** Two small made-up-numbers charts embedded in "About this analysis" so
 * "here's what σ near +1 looks like" is something you can actually SEE
 * instead of just being told. Fictional data only ("Example Forest"), never
 * real basin numbers -- built once, lazily, the first time the About
 * section is opened (same hidden-parent-canvas caution as everywhere else:
 * a chart built while its container has the `hidden` attribute gets stuck
 * at zero size). */
let hydroAboutExampleBuilt = false;
function buildHydroAboutExampleCharts() {
  if (hydroAboutExampleBuilt) return;
  const histCanvas = document.getElementById("hydro-about-example-hist");
  const barCanvas = document.getElementById("hydro-about-example-bar");
  if (!histCanvas || !barCanvas) return;
  hydroAboutExampleBuilt = true;

  const years = [2019, 2020, 2021, 2022, 2023];
  const forestZ = [-0.8, -0.3, 0.2, 0.9, 1.3];
  const flowZ = [-0.6, -0.2, 0.4, 0.7, 1.1];

  new Chart(histCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        { label: "Example Forest (σ)", data: forestZ, borderColor: "#228B22", backgroundColor: "#228B22", tension: 0, pointRadius: 3, spanGaps: false },
        { label: "Example river flow (σ)", data: flowZ, borderColor: "#0f172a", backgroundColor: "#0f172a", tension: 0, pointRadius: 3, spanGaps: false, borderWidth: 2.5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 8, font: { size: 11 } } } },
      scales: {
        x: { ticks: { font: { size: 11 } } },
        y: { title: { display: true, text: "σ from normal (made up)" }, ticks: { font: { size: 11 } } },
      },
    },
  });

  new Chart(barCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: ["Example Forest", "Example river flow"],
      datasets: [{ label: "2023 vs. normal", data: [1.3, 1.1], backgroundColor: ["#228B22", "#0f172a"] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 11 } } },
        y: { suggestedMin: -1.5, suggestedMax: 1.5, title: { display: true, text: "σ from normal (made up)" }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

function setupHydrologyAboutToggle() {
  const btn = document.getElementById("hydro-about-toggle");
  const content = document.getElementById("hydro-about-content");
  if (!btn || !content || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    const wasOpen = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!wasOpen));
    content.hidden = wasOpen;
    btn.classList.toggle("hydro-about-open", !wasOpen);
    if (!wasOpen) buildHydroAboutExampleCharts();
  });
}

// ── Map appearance controls ───────────────────────────────────────────────────

function applyBaseMap() {
  const map = state.map.instance;
  if (!map) return;
  const { baseMap, showLabels } = state.map.opts;

  if (state.map.baseTileLayer) { map.removeLayer(state.map.baseTileLayer); state.map.baseTileLayer = null; }
  if (state.map.labelTileLayer) { map.removeLayer(state.map.labelTileLayer); state.map.labelTileLayer = null; }

  const baseKey = baseMap === "satellite" ? "satellite" : (showLabels ? "street" : "streetNoLabels");
  const cfg = TILE_CONFIGS[baseKey];
  state.map.baseTileLayer = L.tileLayer(cfg.url, { maxZoom: cfg.maxZoom, attribution: cfg.attribution }).addTo(map);

  if (baseMap === "satellite" && showLabels) {
    const lcfg = TILE_CONFIGS.satelliteLabels;
    state.map.labelTileLayer = L.tileLayer(lcfg.url, { maxZoom: lcfg.maxZoom, attribution: lcfg.attribution }).addTo(map);
  }

  document.getElementById("map")?.classList.toggle("satellite-basemap", baseMap === "satellite");
  applyBasinOutlineHighlight(state.map.selectedBasinIndices);
}

/** Shows/hides one land-cover raster layer without removing/re-adding it
 * (which would drop a GridLayer's tile cache) when it has a container to
 * hide via CSS -- true for the flat GeoTIFF overlay and the Esri/GRPK XYZ
 * tile layers, all GridLayer-based. GRPK's close-zoom tier can also be real
 * vector (GeoJSON) chunks, which have no container at all -- those fall
 * back to adding/removing from the map, the only way to hide a vector
 * layer. */
function setRasterLayerVisible(map, layer, visible) {
  if (!layer) return;
  const el = layer.getContainer?.();
  if (el) {
    el.style.display = visible ? "" : "none";
    return;
  }
  const onMap = map.hasLayer(layer);
  if (visible && !onMap) layer.addTo(map);
  else if (!visible && onMap) map.removeLayer(layer);
}

function applyOverlayVisibility() {
  const map = state.map.instance;
  if (!map) return;
  const { showBasins, showBasinLabels, showRaster, showScale } = state.map.opts;

  const basinLayer = state.map.basinLayer;
  if (basinLayer) {
    if (showBasins && !map.hasLayer(basinLayer)) basinLayer.addTo(map);
    else if (!showBasins && map.hasLayer(basinLayer)) map.removeLayer(basinLayer);
  }

  document.getElementById("map")?.classList.toggle("hide-basin-labels", !showBasinLabels);

  // Flat single-file overlay (hildaknn/lucas/hyde/luh2/corine) and Esri/GRPK's
  // tiled layers (persistent XYZ pyramid + GRPK's close-zoom vector chunks)
  // all need the same toggle -- previously only the flat overlay was handled
  // here, so this checkbox silently did nothing while viewing Esri or GRPK.
  setRasterLayerVisible(map, state.map.overlay, showRaster);
  setRasterLayerVisible(map, state.map.esriXyzLayer, showRaster);
  setRasterLayerVisible(map, state.map.grpkXyzLayer, showRaster);
  if (state.map.tiledLayerGroup) {
    state.map.tiledLayerGroup.eachLayer((l) => setRasterLayerVisible(map, l, showRaster));
  }

  const scaleEl = state.map.scaleControl?.getContainer?.();
  if (scaleEl) scaleEl.style.display = showScale ? "" : "none";
  const attrEl = map.attributionControl?.getContainer?.();
  if (attrEl) attrEl.style.display = showScale ? "" : "none";

  const hydroLayer = state.map.hydroStationsLayer;
  if (hydroLayer) {
    if (state.map.opts.showHydroStations && !map.hasLayer(hydroLayer)) hydroLayer.addTo(map);
    else if (!state.map.opts.showHydroStations && map.hasLayer(hydroLayer)) map.removeLayer(hydroLayer);
  }
}

function syncMapOptsUI() {
  const opts = state.map.opts;
  const keyMap = { labels: "showLabels", basins: "showBasins", "basin-labels": "showBasinLabels", raster: "showRaster", scale: "showScale", "hydro-stations": "showHydroStations" };
  document.querySelectorAll("[data-opt]").forEach((el) => {
    const opt = el.dataset.opt;
    if (el.type === "radio") {
      el.checked = el.value === opts.baseMap;
    } else if (el.type === "checkbox") {
      const stateKey = keyMap[opt];
      if (stateKey) el.checked = opts[stateKey];
    }
  });
}

function onMapOptInput(e) {
  const el = e.target;
  if (!el.dataset.opt) return;
  const opt = el.dataset.opt;
  const keyMap = { labels: "showLabels", basins: "showBasins", "basin-labels": "showBasinLabels", raster: "showRaster", scale: "showScale", "hydro-stations": "showHydroStations" };

  if (el.type === "radio" && opt === "basemap" && el.checked) {
    state.map.opts.baseMap = el.value;
    applyBaseMap();
  } else if (el.type === "checkbox") {
    const stateKey = keyMap[opt];
    if (stateKey) {
      state.map.opts[stateKey] = el.checked;
      if (opt === "labels") applyBaseMap();
      else applyOverlayVisibility();
      // The legend's two station-marker entries are conditional on this
      // same option (see setLegend) -- refresh it in place so toggling the
      // layer updates the legend immediately, not just on the next filter
      // apply.
      if (opt === "hydro-stations") refreshLegendForCurrentDataset();
    }
  }
  syncMapOptsUI();
}

function setupMapOptions() {
  document.addEventListener("input", (e) => {
    if (e.target.closest("#panel-mapsettings-float")) onMapOptInput(e);
  });
}

/**
 * Floating utility panels (Filters / Map settings / Info), each opened independently by its
 * own top-left icon button and closable via its own × button. Unlike the old Filters/Map/About
 * sidebar tabs, these are not mutually exclusive — more than one can be open at once.
 */
function setupFloatingPanels() {
  const panels = [
    { btnId: "icon-filters-btn", panelId: "panel-filters-float" },
    { btnId: "icon-mapsettings-btn", panelId: "panel-mapsettings-float" },
    { btnId: "icon-info-btn", panelId: "panel-info-float" },
  ];

  // Mutually exclusive — opening one always closes the others, so they never stack/overlap.
  function closeAllExcept(exceptPanelId) {
    for (const { btnId, panelId } of panels) {
      if (panelId === exceptPanelId) continue;
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = true;
      btn?.setAttribute("aria-expanded", "false");
    }
  }

  for (const { btnId, panelId } of panels) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) continue;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowHidden = !panel.hidden;
      closeAllExcept(panelId);
      panel.hidden = nowHidden;
      btn.setAttribute("aria-expanded", String(!nowHidden));
    });
  }

  document.querySelectorAll("[data-close-panel]").forEach((closeBtn) => {
    closeBtn.addEventListener("click", () => {
      const panelId = closeBtn.dataset.closePanel;
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = true;
      const owner = panels.find((p) => p.panelId === panelId);
      if (owner) document.getElementById(owner.btnId)?.setAttribute("aria-expanded", "false");
    });
  });

  // Click-outside-to-close, same pattern as the old layers popover.
  document.addEventListener("click", (e) => {
    for (const { btnId, panelId } of panels) {
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (!btn || !panel || panel.hidden) continue;
      if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        panel.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    }
  });
}

/** Dashboards panel (Trend / Distribution / Sub-basin / Insights cards), right side. */
function setupDashboardsPanel() {
  const toggleBtn = document.getElementById("dashboards-toggle-btn");
  const panel = document.getElementById("dashboards-panel");
  const closeBtn = document.getElementById("dashboards-close-btn");
  if (!toggleBtn || !panel) return;

  function setOpen(open) {
    panel.hidden = !open;
    toggleBtn.setAttribute("aria-expanded", String(open));
    // Lets the on-map legend/opacity/zoom cluster and the timeline pill shift
    // left to clear the panel while it's open (see styles.css).
    document.body.classList.toggle("dashboards-open", open);
    const map = state.map.instance;
    if (map) requestAnimationFrame(() => map.invalidateSize());
  }

  toggleBtn.addEventListener("click", () => setOpen(true));
  closeBtn?.addEventListener("click", () => setOpen(false));

  setOpen(!panel.hidden); // sync body class to the panel's initial (open) state
}

const DASHBOARDS_PANEL_WIDTH_KEY = "lt-dashboard-panel-width";
const DASHBOARDS_PANEL_MIN_WIDTH = 340;
const DASHBOARDS_PANEL_MAX_WIDTH = 900;

/** Clamps to [MIN_WIDTH, min(MAX_WIDTH, viewport width minus a small
 * margin)] and applies it via the CSS custom property the panel's own
 * width now reads from (see .dashboards-panel in styles.css) -- returns
 * the actual clamped value applied, in px. */
function applyDashboardsPanelWidth(px) {
  const panel = document.getElementById("dashboards-panel");
  if (!panel) return null;
  const maxAllowed = Math.min(DASHBOARDS_PANEL_MAX_WIDTH, window.innerWidth - 32);
  const clamped = Math.max(DASHBOARDS_PANEL_MIN_WIDTH, Math.min(maxAllowed, px));
  // Set on :root, not the panel itself -- the on-map legend/opacity/zoom
  // cluster (styles.css, body.dashboards-open rules) needs to read this
  // same value to shift clear of the panel by the right amount, and none
  // of those elements are descendants of #dashboards-panel, so a custom
  // property set there wouldn't reach them.
  document.documentElement.style.setProperty("--dashboards-panel-width", `${clamped}px`);
  return clamped;
}

/** Drag-to-resize for the right-hand sidebar, via the thin strip along its
 * left edge (id=dashboards-panel-resize-handle). The panel is anchored to
 * the screen's right edge, so dragging the handle LEFT (toward screen
 * center) grows it, and the delta is measured against the pointer's
 * starting X, not its absolute position, so the drag feels 1:1 regardless
 * of where along the handle you grabbed it. The chosen width persists to
 * localStorage and is restored on load; below the 1100px layout breakpoint
 * the handle is hidden entirely (styles.css) and the panel reverts to its
 * fixed, viewport-driven mobile width, so nothing here needs to special-
 * case that width. */
function setupDashboardsPanelResize() {
  const panel = document.getElementById("dashboards-panel");
  const handle = document.getElementById("dashboards-panel-resize-handle");
  if (!panel || !handle || handle.dataset.bound) return;
  handle.dataset.bound = "1";

  try {
    const saved = parseInt(localStorage.getItem(DASHBOARDS_PANEL_WIDTH_KEY), 10);
    if (Number.isFinite(saved)) applyDashboardsPanelWidth(saved);
  } catch (e) {
    console.warn("Could not read saved sidebar width", e);
  }

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  function onPointerMove(e) {
    if (!dragging) return;
    applyDashboardsPanelWidth(startWidth + (startX - e.clientX));
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    document.body.style.userSelect = "";
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    const finalWidth = Math.round(panel.getBoundingClientRect().width);
    try {
      localStorage.setItem(DASHBOARDS_PANEL_WIDTH_KEY, String(finalWidth));
    } catch (e) {
      console.warn("Could not save sidebar width", e);
    }
  }

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add("is-dragging");
    document.body.style.userSelect = "none"; // otherwise dragging selects sidebar text
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    e.preventDefault();
  });

  // Keyboard resize: Left/Right arrows while the handle has focus, for
  // anyone who can't (or doesn't want to) drag with a mouse.
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = panel.getBoundingClientRect().width;
    const next = applyDashboardsPanelWidth(current + (e.key === "ArrowLeft" ? 20 : -20));
    if (next != null) {
      try {
        localStorage.setItem(DASHBOARDS_PANEL_WIDTH_KEY, String(Math.round(next)));
      } catch (err) {
        console.warn("Could not save sidebar width", err);
      }
    }
  });

  // Keeps an already-saved wide width from pushing the panel off-screen if
  // the browser window is later made narrower.
  window.addEventListener("resize", () => {
    const current = panel.getBoundingClientRect().width;
    if (current > 0) applyDashboardsPanelWidth(current);
  });
}

/**
 * Expand-to-modal for each dashboards card. Toggles a CSS class rather than moving the card in
 * the DOM — relocating a mounted Chart.js canvas between containers frequently breaks its
 * rendering context, so the card is enlarged in place via `position:fixed` instead.
 */
function setupDashCardExpand() {
  const dashboardsPanel = document.getElementById("dashboards-panel");
  let backdrop = document.querySelector(".dash-card-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "dash-card-backdrop";
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
  }

  // Chart.js's responsive sizing reads its canvas's container box at the moment
  // resize() runs — one rAF isn't always enough for the fixed-position layout
  // change to have fully reflowed, so resize again shortly after too.
  function resizeCharts() {
    state.charts.trend?.resize();
    state.charts.distribution?.resize();
    requestAnimationFrame(() => {
      state.charts.trend?.resize();
      state.charts.distribution?.resize();
      setTimeout(() => {
        state.charts.trend?.resize();
        state.charts.distribution?.resize();
      }, 260); // clears the .dash-card.is-expanded CSS transition, if any
    });
  }

  function collapseAll() {
    document.querySelectorAll(".dash-card.is-expanded").forEach((card) => {
      card.classList.remove("is-expanded");
    });
    dashboardsPanel?.classList.remove("panel-has-expanded");
    backdrop.hidden = true;
    resizeCharts();
  }

  document.querySelectorAll(".dash-card-expand-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = document.getElementById(btn.dataset.expandCard);
      if (!card) return;
      const willExpand = !card.classList.contains("is-expanded");
      collapseAll();
      if (willExpand) {
        card.classList.add("is-expanded");
        // .dashboards-panel is itself position:fixed + z-index, which creates its
        // own stacking context — the card's z-index alone can't out-rank the
        // backdrop (a <body>-level sibling of the panel) unless the panel's own
        // z-index is also raised above it. See the CSS comment on this class.
        dashboardsPanel?.classList.add("panel-has-expanded");
        backdrop.hidden = false;
      }
      resizeCharts();
    });
  });

  backdrop.addEventListener("click", collapseAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") collapseAll();
  });
}

/**
 * "Find location" — free-text place/city search (OpenStreetMap Nominatim, no API key) plus a
 * direct lat/lon jump. Wired twice (sidebar + fullscreen popover use separate DOM ids since
 * both can be visible/hidden independently) but shares one marker and one in-flight request.
 */
function setupLocationSearch() {
  const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  // Soft bias toward Lithuania (same bounding box used elsewhere) without excluding matches
  // elsewhere — e.g. searching a neighbouring city for context should still work.
  const LT_VIEWBOX = "20.45,56.65,26.85,53.45";

  let searchSeq = 0; // ignore stale responses if the user re-searches before the first reply lands

  function setStatus(statusEl, message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.hidden = !message;
    statusEl.classList.toggle("is-error", !!isError);
  }

  function clearResults(resultsEl) {
    if (!resultsEl) return;
    resultsEl.innerHTML = "";
    resultsEl.hidden = true;
  }

  function placeMarker(lat, lon, label) {
    const map = state.map.instance;
    if (!map) return;
    if (state.map.searchMarker) {
      map.removeLayer(state.map.searchMarker);
      state.map.searchMarker = null;
    }
    const marker = L.marker([lat, lon]);
    if (label) marker.bindPopup(label);
    marker.addTo(map);
    state.map.searchMarker = marker;
    document.querySelectorAll(".location-clear-btn").forEach((btn) => { btn.hidden = false; });
  }

  function goToLatLon(lat, lon, { zoom, bounds, label } = {}) {
    const map = state.map.instance;
    if (!map) return;
    if (bounds) {
      map.fitBounds(bounds, { maxZoom: 15 });
    } else {
      map.setView([lat, lon], zoom ?? 13);
    }
    placeMarker(lat, lon, label);
  }

  function clearPin() {
    const map = state.map.instance;
    if (map && state.map.searchMarker) {
      map.removeLayer(state.map.searchMarker);
    }
    state.map.searchMarker = null;
    document.querySelectorAll(".location-clear-btn").forEach((btn) => { btn.hidden = true; });
  }

  async function runPlaceSearch(query, resultsEl, statusEl) {
    const q = (query || "").trim();
    if (!q) {
      setStatus(statusEl, "Type a place or city name.", true);
      return;
    }
    const mySeq = ++searchSeq;
    clearResults(resultsEl);
    setStatus(statusEl, "Searching…");

    const url = `${NOMINATIM_URL}?format=jsonv2&q=${encodeURIComponent(q)}&viewbox=${LT_VIEWBOX}&limit=6`;
    let results;
    try {
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (mySeq !== searchSeq) return; // a newer search superseded this one
      if (!resp.ok) {
        setStatus(statusEl, `Search failed (HTTP ${resp.status}).`, true);
        return;
      }
      results = await resp.json();
    } catch (e) {
      if (mySeq !== searchSeq) return;
      console.warn("Place search failed", e);
      setStatus(statusEl, "Search failed — check your internet connection.", true);
      return;
    }
    if (mySeq !== searchSeq) return;

    if (!results || results.length === 0) {
      setStatus(statusEl, `No results for "${q}".`, true);
      return;
    }

    setStatus(statusEl, "");
    if (results.length === 1) {
      applyResult(results[0]);
      return;
    }

    resultsEl.hidden = false;
    resultsEl.innerHTML = "";
    for (const r of results) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "place-search-result-item";
      btn.textContent = r.display_name;
      btn.addEventListener("click", () => {
        applyResult(r);
        clearResults(resultsEl);
      });
      resultsEl.appendChild(btn);
    }

    function applyResult(r) {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null;
      const bounds = bb && bb.every(Number.isFinite) ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null;
      goToLatLon(lat, lon, { bounds, label: r.display_name });
    }
  }

  function runCoordSearch(latInput, lonInput, statusEl) {
    const lat = parseFloat(latInput.value);
    const lon = parseFloat(lonInput.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setStatus(statusEl, "Enter numeric latitude and longitude.", true);
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setStatus(statusEl, "Latitude must be -90..90, longitude -180..180.", true);
      return;
    }
    setStatus(statusEl, "");
    goToLatLon(lat, lon, { zoom: 13, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  }

  function wireInstance(prefix) {
    const placeInput = document.getElementById(`${prefix}place-search-input`);
    const placeBtn = document.getElementById(`${prefix}place-search-btn`);
    const resultsEl = document.getElementById(`${prefix}place-search-results`);
    const latInput = document.getElementById(`${prefix}coord-lat-input`);
    const lonInput = document.getElementById(`${prefix}coord-lon-input`);
    const coordBtn = document.getElementById(`${prefix}coord-go-btn`);
    const statusEl = document.getElementById(`${prefix}location-search-status`);
    const clearBtn = document.getElementById(`${prefix}location-clear-btn`);
    if (!placeInput || !placeBtn) return;

    placeBtn.addEventListener("click", () => runPlaceSearch(placeInput.value, resultsEl, statusEl));
    placeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runPlaceSearch(placeInput.value, resultsEl, statusEl);
      }
    });
    document.addEventListener("click", (e) => {
      if (resultsEl && !resultsEl.hidden && !resultsEl.contains(e.target) && e.target !== placeInput) {
        clearResults(resultsEl);
      }
    });

    coordBtn.addEventListener("click", () => runCoordSearch(latInput, lonInput, statusEl));
    for (const el of [latInput, lonInput]) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runCoordSearch(latInput, lonInput, statusEl);
        }
      });
    }

    clearBtn?.addEventListener("click", clearPin);
  }

  wireInstance("");
}

function getBasinLeafletLayer(basinIndex) {
  const group = state.map.basinLayer;
  if (!group || !Number.isFinite(basinIndex)) return null;
  let found = null;
  group.eachLayer((ly) => {
    if (ly._basinIndex === basinIndex) found = ly;
  });
  return found;
}

/** Basin selection now handled via checkbox panel in main(). */
function setupBasinZoom() {}

function getGeotiffUrl(datasetKey, year) {
  const rel = {
    hildaknn: `rasters/hildaknn/geotiff/hildaknn_${year}.tif`,
    lucas: `rasters/lucas/geotiff/lucas_${year}.tif`,
    hyde: `rasters/hyde/geotiff/hyde_${year}.tif`,
    luh2: `rasters/luh2/geotiff/luh2_${year}.tif`,
    corine: `rasters/corine/geotiff/corine_${year}.tif`,
    esri: `rasters/esri/geotiff/esri_${year}.tif`,
    grpk: `rasters/grpk/geotiff/grpk_${year}.tif`,
  }[datasetKey];
  return rel ? resolveDataFileUrl(rel) : null;
}

async function getGeorasterCached(datasetKey, year) {
  const cacheKey = `${datasetKey}|${year}`;
  if (state.georasterCache.has(cacheKey)) {
    console.log(`[Raster] cache hit: ${cacheKey}`);
    return state.georasterCache.get(cacheKey);
  }
  const url = getGeotiffUrl(datasetKey, year);
  if (!url) return null;
  console.time(`[Raster] fetch ${cacheKey}`);
  // no-store: these GeoTIFFs get patched in place by analysis scripts (e.g.
  // water-exclusion fixes) without their filename ever changing, and the
  // server sends no Cache-Control header — so a normal fetch() can let the
  // browser's heuristic HTTP cache silently keep serving pre-fix bytes
  // across reloads even though the file on disk is current.
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) { console.timeEnd(`[Raster] fetch ${cacheKey}`); return null; }
  const buf = await resp.arrayBuffer();
  console.timeEnd(`[Raster] fetch ${cacheKey}`);
  if (typeof parseGeoraster === "undefined") return null;
  console.time(`[Raster] parse ${cacheKey}`);
  const gr = await parseGeoraster(buf);
  console.timeEnd(`[Raster] parse ${cacheKey}`);
  if (gr) {
    console.log(`[Raster] parsed ${cacheKey}: ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB, size ${gr.width}×${gr.height}`);
    state.georasterCache.set(cacheKey, gr);
  }
  return gr;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeCsvCell(s) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

const FIVE_CLASSES_ORDER = ["Water", "Wetland", "Urban", "Agriculture", "Forest"];

/** Display labels for national/sub-basin charts (HYDE class 5 is not a forest layer). */
function nationalDistributionClassLabels(datasetKey) {
  if (datasetKey === "hyde") {
    return ["Water", "Wetland", "Urban", "Agriculture", "Natural (residual)"];
  }
  return FIVE_CLASSES_ORDER.slice();
}

/** Map CSV class_name (e.g. CORINE "Wetlands") to canonical 5-class id for zonal export */
function csvClassNameToBasinClassId(csvName) {
  if (!csvName || csvName === "ALL") return null;
  const norm = normalizeClassName(csvName);
  return NAME_TO_CLASS_ID[norm] ?? null;
}

/** Trimmed year from a number input; empty → NaN (never treat "" as 0). */
function parseYearInputEl(el) {
  if (!el) return NaN;
  const t = String(el.value ?? "").trim();
  if (t === "") return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function readFilterYearRange() {
  const fromEl = document.getElementById("year-from");
  const toEl = document.getElementById("year-to");
  const fromY = parseYearInputEl(fromEl);
  const toY = parseYearInputEl(toEl);
  return { fromY, toY };
}

/**
 * Years to export: basin → union of zonal years for that basin; else national CSV/raster years.
 * Empty from/to → all years in pool; partial range clamps to pool bounds.
 */
function resolveExportYears(datasetKey, basinIndex) {
  const { fromY, toY } = readFilterYearRange();
  const rasterYears = state.rasterYearsByDataset[datasetKey];
  const sliderYears = getYearsForMapSlider(datasetKey);
  const nationalPool = (rasterYears !== null && rasterYears.length ? rasterYears : sliderYears)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);

  let pool;
  if (Number.isFinite(basinIndex)) {
    const idx = state.subbasinZonal[datasetKey];
    if (!(idx instanceof Map)) {
      return { years: [], error: "zonal" };
    }
    const ys = new Set();
    idx.forEach((_, key) => {
      const parts = String(key).split("|");
      const bi = Number(parts[0]);
      const y = Number(parts[1]);
      if (bi === basinIndex && Number.isFinite(y)) ys.add(y);
    });
    pool = Array.from(ys).sort((a, b) => a - b);
    if (!pool.length) {
      return { years: [], error: "basin_years" };
    }
  } else {
    pool = nationalPool;
    if (!pool.length) {
      return { years: [], error: "national_years" };
    }
  }

  const hasFrom = Number.isFinite(fromY);
  const hasTo = Number.isFinite(toY);
  if (!hasFrom && !hasTo) {
    return { years: pool, error: null };
  }

  let lo;
  let hi;
  if (hasFrom && hasTo) {
    lo = Math.min(fromY, toY);
    hi = Math.max(fromY, toY);
  } else if (hasFrom) {
    lo = fromY;
    hi = pool[pool.length - 1];
  } else {
    lo = pool[0];
    hi = toY;
  }

  const years = pool.filter((y) => y >= lo && y <= hi);
  return { years, error: years.length ? null : "range_empty" };
}

const EXPORT_HEADER = [
  "Subbasin",
  "Land_cover_type",
  "Area_cells",
  "Pct_of_basin_total",
  "Pct_among_selected_classes",
  "Dataset",
  "Year",
];

function appendNationalRowsForYear(aoa, datasetKey, year, selectedClasses) {
  const data = state[datasetKey];
  if (!data?.length) return;
  const filtered = data.filter((r) => r.year === year);
  const byClass = {};
  filtered.forEach((r) => {
    byClass[r.class_name] = (byClass[r.class_name] || 0) + r.count;
  });
  // totalNat: sum of ALL national classes — denominator for Pct_of_total
  const totalNat = Object.values(byClass).reduce((s, v) => s + v, 0);
  const allClassesSelected = selectedClasses.length >= CANONICAL_CLASSES.length;
  const selectedIds = new Set(selectedClasses.map((s) => NAME_TO_CLASS_ID[s]).filter(Boolean));
  let classNames = Object.keys(byClass).sort();
  if (!allClassesSelected) {
    classNames = classNames.filter((c) => selectedIds.has(NAME_TO_CLASS_ID[c]));
  }
  // sumSelectedNat: sum of ONLY selected classes — denominator for Pct_of_classified
  const sumSelectedNat = classNames.reduce((s, cls) => s + (byClass[cls] || 0), 0);
  classNames.forEach((cls) => {
    const cnt = byClass[cls];
    const pctTotal = totalNat > 0 ? (cnt / totalNat) * 100 : 0;
    const pctClassified = sumSelectedNat > 0 ? (cnt / sumSelectedNat) * 100 : 0;
    aoa.push(["Lithuania (national)", cls, cnt, Number(pctTotal.toFixed(4)), Number(pctClassified.toFixed(4)), datasetKey, year]);
  });
}

function appendBasinRowsForYear(aoa, datasetKey, year, basinIndex, basinName, selectedClasses, index) {
  const cell = index.get(`${basinIndex}|${year}`);
  const total = cell?.total ?? 0;
  const allClassesSelected = selectedClasses.length >= CANONICAL_CLASSES.length;
  const selectedIds = new Set(selectedClasses.map((s) => NAME_TO_CLASS_ID[s]).filter(Boolean));
  let classes = nationalDistributionClassLabels(datasetKey).slice();
  if (!allClassesSelected) {
    classes = classes.filter((c) => selectedIds.has(NAME_TO_CLASS_ID[c]));
  }
  // Pct_of_classified denominator = sum of ONLY the selected classes
  const sumSelectedClasses = classes.reduce((s, cls) => s + (cell?.counts[NAME_TO_CLASS_ID[cls]] ?? 0), 0);
  classes.forEach((cls) => {
    const id = NAME_TO_CLASS_ID[cls];
    const cnt = cell?.counts[id] ?? 0;
    const pctTotal = total > 0 ? (cnt / total) * 100 : 0;
    const pctClassified = sumSelectedClasses > 0 ? (cnt / sumSelectedClasses) * 100 : 0;
    aoa.push([basinName, cls, cnt, Number(pctTotal.toFixed(4)), Number(pctClassified.toFixed(4)), datasetKey, year]);
  });
  // Unclassified row — only when all 5 classes are selected
  if (allClassesSelected) {
    const sumAllClassified = [1, 2, 3, 4, 5].reduce((s, id) => s + (cell?.counts[id] ?? 0), 0);
    const unclassifiedCnt = total - sumAllClassified;
    if (total > 0 && unclassifiedCnt > 0) {
      const pctTotal = (unclassifiedCnt / total) * 100;
      aoa.push([basinName, "Unclassified", unclassifiedCnt, Number(pctTotal.toFixed(4)), "", datasetKey, year]);
    }
  }
}

function buildExportDataAoas(datasetKey, years, basinIndex, basinName, selectedClasses) {
  const byYear = [EXPORT_HEADER.slice()];
  let rowCount = 0;

  if (Number.isFinite(basinIndex)) {
    const index = state.subbasinZonal[datasetKey];
    years.forEach((year, yi) => {
      const startLen = byYear.length;
      appendBasinRowsForYear(byYear, datasetKey, year, basinIndex, basinName, selectedClasses, index);
      rowCount += byYear.length - startLen;
      if (yi < years.length - 1) {
        byYear.push(new Array(EXPORT_HEADER.length).fill(""));
      }
    });
  } else {
    years.forEach((year, yi) => {
      const startLen = byYear.length;
      appendNationalRowsForYear(byYear, datasetKey, year, selectedClasses);
      rowCount += byYear.length - startLen;
      if (yi < years.length - 1) {
        byYear.push(new Array(EXPORT_HEADER.length).fill(""));
      }
    });
  }

  return { byYear, rowCount };
}

function buildExportInfoAoa(datasetKey, years, basinIndex, basinName, selectedClass) {
  const { fromY, toY } = readFilterYearRange();
  const yLabel =
    years.length === 0
      ? "—"
      : years.length === 1
        ? String(years[0])
        : `${years[0]}–${years[years.length - 1]} (${years.length} years)`;
  const rangeInput =
    Number.isFinite(fromY) || Number.isFinite(toY)
      ? `${Number.isFinite(fromY) ? fromY : "…"} – ${Number.isFinite(toY) ? toY : "…"}`
      : "(empty = all years available for this scope)";
  return [
    ["Land cover export — filters used"],
    [],
    ["Dataset", datasetKey],
    ["Scope", Number.isFinite(basinIndex) ? `Sub-basin: ${basinName}` : "National (whole Lithuania)"],
    ["Years in this file", yLabel],
    ["Year range fields (sidebar)", rangeInput],
    ["Class filter", selectedClass === "ALL" ? "All classes" : selectedClass],
    [],
    [
      "Charts sheet",
      "Embedded PNG figures from Chart.js: pie = latest year in this export; line = class share (%) vs year (same filters as data).",
    ],
    [],
    ["Reading the workbook"],
    [
      "By year",
      "Rows grouped by calendar year; a blank row separates each year for readability. Enable AutoFilter on the header row.",
    ],
    [
      "By class",
      "Same data sorted by land-cover type, then basin, then year — convenient for comparing one class across years.",
    ],
  ];
}

function applyLandCoverSheetLayout(ws) {
  ws["!cols"] = [
    { wch: 36 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 8 },
    { wch: 72 },
  ];
  if (ws["!ref"]) {
    ws["!autofilter"] = { ref: ws["!ref"] };
  }
  ws["!views"] = [{ ySplit: 1, xSplit: 0, topLeftCell: "A2", activeCell: "A2", state: "frozen" }];
}

const EXPORT_CHART_COLORS = {
  Water: "rgba(77,166,255,0.95)",
  Wetland: "rgba(123,104,238,0.95)",
  Wetlands: "rgba(123,104,238,0.95)",
  Urban: "rgba(255,77,77,0.95)",
  Agriculture: "rgba(255,210,77,0.95)",
  Forest: "rgba(34,139,34,0.95)",
  "Natural (residual)": "rgba(34,139,34,0.95)",
  Unclassified: "rgba(160,160,160,0.85)",
};

function exportChartColorForClass(name) {
  return EXPORT_CHART_COLORS[name] || "rgba(100,116,139,0.9)";
}

/** Percentage by class and year (matches export filters) for chart layer */
function collectSharesForExportCharts(datasetKey, years, basinIndex, selectedClass) {
  if (!years.length) return null;
  const latestYear = years[years.length - 1];

  if (Number.isFinite(basinIndex)) {
    const index = state.subbasinZonal[datasetKey];
    if (!(index instanceof Map)) return null;
    let classes = nationalDistributionClassLabels(datasetKey).slice();
    if (selectedClass && selectedClass !== "ALL") {
      const wantId = csvClassNameToBasinClassId(selectedClass);
      if (!wantId) return { classes: [], byYear: {}, latestYear, scope: "basin" };
      classes = classes.filter((c) => NAME_TO_CLASS_ID[c] === wantId);
    }
    const byYear = {};
    years.forEach((year) => {
      const cell = index.get(`${basinIndex}|${year}`);
      const total = cell?.total ?? 0;
      const row = {};
      classes.forEach((cls) => {
        const id = NAME_TO_CLASS_ID[cls];
        const cnt = cell?.counts[id] ?? 0;
        row[cls] = total > 0 ? (cnt / total) * 100 : 0;
      });
      byYear[year] = row;
    });
    return { classes, byYear, latestYear, scope: "basin" };
  }

  const data = state[datasetKey];
  if (!data?.length) return null;
  const classSet = new Set();
  years.forEach((year) => {
    data.filter((r) => r.year === year).forEach((r) => classSet.add(r.class_name));
  });
  let classes = Array.from(classSet).sort();
  if (selectedClass && selectedClass !== "ALL") {
    classes = classes.filter((c) => c === selectedClass);
  }
  const byYear = {};
  years.forEach((year) => {
    const filtered = data.filter((r) => r.year === year);
    const agg = {};
    filtered.forEach((r) => {
      agg[r.class_name] = (agg[r.class_name] || 0) + r.count;
    });
    const tot = classes.reduce((s, c) => s + (agg[c] || 0), 0);
    const row = {};
    classes.forEach((c) => {
      row[c] = tot > 0 ? ((agg[c] || 0) / tot) * 100 : 0;
    });
    byYear[year] = row;
  });
  return { classes, byYear, latestYear, scope: "national" };
}

function applyExcelJsLandCoverSheet(worksheet, aoa) {
  applyExcelJsLandCoverSheetStyled(worksheet, aoa);
}

const CLASS_CELL_COLORS = {
  Water: "FFD6EAFF", Wetland: "FFE8E0FF", Urban: "FFFFE0E0",
  Agriculture: "FFFFF5CC", Forest: "FFD5EBD5",
  Unclassified: "FFF0F0F0",
};

function applyExcelJsLandCoverSheetStyled(worksheet, aoa) {
  // Subbasin | Land_cover_type | Area_cells | Pct_of_total | Pct_of_classified | Dataset | Year
  [36, 22, 14, 12, 12, 10, 8].forEach((w, i) => { worksheet.getColumn(i + 1).width = w; });

  aoa.forEach((rowData, ri) => {
    const excelRow = worksheet.getRow(ri + 1);
    const isHeader = ri === 0;
    const isEmpty = rowData.every((v) => v === "" || v == null);

    rowData.forEach((val, ci) => {
      const cell = excelRow.getCell(ci + 1);
      cell.value = val === "" || val == null ? "" : val;

      if (isHeader) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { bottom: { style: "medium", color: { argb: "FF0B4F71" } } };
      } else if (!isEmpty) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ri % 2 === 1 ? "FFF1F5F9" : "FFFFFFFF" } };
        if (ci === 1 && typeof val === "string" && CLASS_CELL_COLORS[val]) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLASS_CELL_COLORS[val] } };
          cell.font = { bold: true, size: 10 };
        }
        // Pct_of_total (col 4) and Pct_of_classified (col 5)
        if ((ci === 3 || ci === 4) && typeof val === "number") {
          cell.numFmt = "0.0000";
          cell.alignment = { horizontal: "right" };
        }
      }
    });
    if (isHeader) excelRow.height = 22;
  });

  const lastRow = Math.max(1, aoa.length);
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: EXPORT_HEADER.length } };
  worksheet.views = [{ state: "frozen", ySplit: 1, xSplit: 0, topLeftCell: "A2", activeCell: "A2" }];
}

function buildExportInfoAoaMulti(datasetKey, years, scopes, selectedClasses) {
  const { fromY, toY } = readFilterYearRange();
  const yLabel = years.length === 0 ? "—" : years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]} (${years.length} years)`;
  const rangeInput = Number.isFinite(fromY) || Number.isFinite(toY)
    ? `${Number.isFinite(fromY) ? fromY : "…"} – ${Number.isFinite(toY) ? toY : "…"}`
    : "(all years available)";
  const isNational = scopes.length === 1 && !Number.isFinite(scopes[0].basinIndex);
  const scopeDesc = isNational ? "National (whole Lithuania)" : scopes.map((s) => s.basinName).join(", ");
  return [
    ["Land cover export — filters used"],
    [],
    ["Dataset", datasetKey],
    ["Scope", scopeDesc],
    ["Years in this file", yLabel],
    ["Year range (sidebar)", rangeInput],
    ["Classes exported", selectedClasses.join(", ")],
    [],
    ["Sheet structure"],
    ["Basin sheets", `One sheet per selected scope (${scopes.length} total) — all classes, all years.`],
    ["Class sheets", `One sheet per selected class (${selectedClasses.length} total) — all scopes, all years.`],
  ];
}

function buildPieChartConfig(classes, byYear, latestYear, titleSuffix) {
  const row = byYear[latestYear] || {};
  const pairs = classes.map((c) => ({ c, v: row[c] ?? 0 })).filter((p) => p.v > 0.0001);
  if (!pairs.length) return null;
  return {
    type: "pie",
    data: {
      labels: pairs.map((p) => p.c),
      datasets: [
        {
          data: pairs.map((p) => Number(p.v.toFixed(3))),
          backgroundColor: pairs.map((p) => exportChartColorForClass(p.c)),
          borderColor: "#ffffff",
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Land cover ${titleSuffix} — ${latestYear} (%)`,
          font: { size: 14 },
        },
        legend: { position: "right", labels: { boxWidth: 11, font: { size: 11 } } },
      },
    },
  };
}

function buildLineChartConfig(classes, byYear, years, titleSuffix) {
  if (!classes.length) return null;
  return {
    type: "line",
    data: {
      labels: years.map(String),
      datasets: classes.map((c) => ({
        label: c,
        data: years.map((y) => Number((byYear[y]?.[c] ?? 0).toFixed(4))),
        borderColor: exportChartColorForClass(c),
        backgroundColor: exportChartColorForClass(c).replace("0.95", "0.15"),
        fill: false,
        tension: 0.25,
        pointRadius: years.length > 40 ? 0 : 3,
        borderWidth: 2,
      })),
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Class share over time ${titleSuffix} (%)`,
          font: { size: 14 },
        },
        legend: {
          position: "bottom",
          labels: { boxWidth: 10, font: { size: 10 } },
        },
      },
      scales: {
        x: { title: { display: true, text: "Year" } },
        y: {
          beginAtZero: true,
          suggestedMax: 100,
          title: { display: true, text: "Share (%)" },
        },
      },
    },
  };
}

// ── Interactive Charts sheet: formula-driven native pie chart ─────────────────

function colNumToLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Returns flat rows [{scope, year, className, count}] + classesToShow array.
// Long-format: one row per (scope × year × class), used for SUMPRODUCT lookup.
function buildChartTableData(datasetKey, years, chartScopes, selectedClasses) {
  const classesToShow = CANONICAL_CLASSES.filter((c) => selectedClasses.includes(c));
  const flatRows = [];
  for (const scope of chartScopes) {
    for (const year of years) {
      for (const cls of classesToShow) {
        let count = 0;
        if (!Number.isFinite(scope.basinIndex)) {
          const id = NAME_TO_CLASS_ID[cls];
          count = (state[datasetKey]?.filter((r) => r.year === year && Number(r.class_id) === id) ?? [])
            .reduce((s, r) => s + r.count, 0);
        } else {
          const index = state.subbasinZonal[datasetKey];
          const cell = (index instanceof Map) ? index.get(`${scope.basinIndex}|${year}`) : null;
          const id = NAME_TO_CLASS_ID[cls];
          count = id ? (cell?.counts[id] ?? 0) : 0;
        }
        flatRows.push({ scope: scope.name, year: Number(year), className: cls, count });
      }
    }
  }
  return { flatRows, classesToShow };
}

// Returns the initial chart values {className: count} for the default selection
// (first scope, last year) — used to pre-fill the chart cache so it shows data
// immediately on file open without waiting for formula recalculation.
function buildInitialChartValues(flatRows, classesToShow, defaultScope, defaultYear) {
  const vals = {};
  for (const cls of classesToShow) {
    const row = flatRows.find((r) => r.scope === defaultScope && r.year === Number(defaultYear) && r.className === cls);
    vals[cls] = row ? row.count : 0;
  }
  return vals;
}

function buildChartsWorksheetFormulaDriven(wb, datasetKey, years, chartScopes, selectedClasses) {
  const { flatRows, classesToShow } = buildChartTableData(datasetKey, years, chartScopes, selectedClasses);
  const scopeNames = chartScopes.map((s) => s.name);
  const yearNums = years.map(Number);
  const n = classesToShow.length;
  const lastDataRow = 1 + flatRows.length; // rows 2..lastDataRow in _ChartData

  // ── Hidden data sheet (_ChartData) ──────────────────────────────────────────
  // All heavyweight data lives here so the Charts sheet stays clean.
  // Layout: A=scope  B=year  C=class  D=count  |  F=cat labels  G=chart values
  //         H=title  I=year list  J=scope list
  const ds = wb.addWorksheet("_ChartData");
  ds.state = "hidden";

  ds.getCell(1, 1).value = "Scope"; ds.getCell(1, 2).value = "Year";
  ds.getCell(1, 3).value = "Class"; ds.getCell(1, 4).value = "Count";
  flatRows.forEach((row, ri) => {
    ds.getCell(2 + ri, 1).value = row.scope;
    const yc = ds.getCell(2 + ri, 2); yc.value = row.year; yc.numFmt = "0";
    ds.getCell(2 + ri, 3).value = row.className;
    ds.getCell(2 + ri, 4).value = row.count;
  });

  // F: chart category labels (class names)
  classesToShow.forEach((cls, i) => { ds.getCell(2 + i, 6).value = cls; });

  // G: chart values — SUMPRODUCT cross-referencing the picker on Charts!$B$4/$B$5
  classesToShow.forEach((cls, i) => {
    ds.getCell(2 + i, 7).value = {
      formula: `=SUMPRODUCT(($A$2:$A$${lastDataRow}=Charts!$B$4)*(TEXT($B$2:$B$${lastDataRow},"0")=TEXT(Charts!$B$5,"0"))*($C$2:$C$${lastDataRow}=$F$${2 + i})*$D$2:$D$${lastDataRow})`,
    };
  });

  // H1: title formula (chart title cell)
  ds.getCell(1, 8).value = { formula: '=Charts!$B$4&" — Year: "&TEXT(Charts!$B$5,"0")' };

  // I: year dropdown list
  ds.getCell(1, 9).value = "_years";
  yearNums.forEach((yr, i) => { const c = ds.getCell(2 + i, 9); c.value = yr; c.numFmt = "0"; });

  // J: scope dropdown list
  ds.getCell(1, 10).value = "_scopes";
  scopeNames.forEach((nm, i) => { ds.getCell(2 + i, 10).value = nm; });

  // ── Visible Charts sheet ─────────────────────────────────────────────────────
  const fig = wb.addWorksheet("Charts");

  const h1 = fig.getCell(1, 1);
  h1.value = "Land Cover Distribution — Interactive Pie Chart";
  h1.font = { bold: true, size: 14, color: { argb: "FF0F172A" } };
  fig.mergeCells(1, 1, 1, 8);

  const h2 = fig.getCell(2, 1);
  h2.value = "Change the dropdowns to switch scope or year — the chart updates automatically.";
  h2.font = { italic: true, size: 10, color: { argb: "FF64748B" } };
  fig.mergeCells(2, 1, 2, 8);

  fig.getCell(4, 1).value = "Scope:"; fig.getCell(4, 1).font = { bold: true };
  fig.getCell(5, 1).value = "Year:";  fig.getCell(5, 1).font = { bold: true };

  const scopeCell = fig.getCell(4, 2);
  scopeCell.value = scopeNames[0];
  scopeCell.dataValidation = {
    type: "list", allowBlank: false, showDropDown: false,
    formulae: [`_ChartData!$J$2:$J$${1 + scopeNames.length}`],
  };

  const yearCell = fig.getCell(5, 2);
  yearCell.value = yearNums[yearNums.length - 1];
  yearCell.numFmt = "0";
  yearCell.dataValidation = {
    type: "list", allowBlank: false, showDropDown: false,
    formulae: [`_ChartData!$I$2:$I$${1 + yearNums.length}`],
  };

  fig.getCell(6, 1).value = "↓  Chart below (rows 7–32) updates when you change either dropdown";
  fig.getCell(6, 1).font = { italic: true, size: 9, color: { argb: "FF94A3B8" } };
  fig.mergeCells(6, 1, 6, 8);

  fig.getColumn(1).width = 10;
  fig.getColumn(2).width = 34;
  for (let c = 3; c <= 8; c++) fig.getColumn(c).width = 13;

  return { flatRows, classesToShow, n };
}

// Builds OOXML chart XML for a native Excel pie chart.
// initialValues: {className: count} for the default scope/year — pre-fills the
// numCache so Excel shows data on first open (before formula recalculation).
function buildNativePieChartXml(classesToShow, initialTitle, initialValues) {
  const n = classesToShow.length;
  const lastRow = 1 + n;
  const COLORS = { Water: "4DA6FF", Wetland: "7B68EE", Urban: "FF4D4D", Agriculture: "FFD24D", Forest: "228B22" };

  const dPts = classesToShow.map((cls, i) => {
    const col = COLORS[cls] || "AAAAAA";
    return `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`;
  }).join("");

  const catPts = classesToShow.map((cls, i) => `<c:pt idx="${i}"><c:v>${cls}</c:v></c:pt>`).join("");
  const valPts = classesToShow.map((cls, i) => {
    const v = initialValues ? (initialValues[cls] || 0) : 0;
    return `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`;
  }).join("");
  const safeTitle = (initialTitle || "Land Cover").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/>
<c:chart>
  <c:title><c:tx><c:strRef><c:f>_ChartData!$H$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${safeTitle}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:overlay val="0"/></c:title>
  <c:autoTitleDeleted val="0"/>
  <c:plotArea><c:layout/>
    <c:pieChart>
      <c:varyColors val="1"/>
      <c:ser>
        <c:idx val="0"/><c:order val="0"/>
        ${dPts}
        <c:dLbls>
          <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
          <c:numFmt formatCode="0.0%" sourceLinked="0"/>
          <c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/>
          <c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/>
          <c:showLeaderLines val="1"/>
        </c:dLbls>
        <c:cat><c:strRef><c:f>_ChartData!$F$2:$F$${lastRow}</c:f><c:strCache><c:ptCount val="${n}"/>${catPts}</c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:f>_ChartData!$G$2:$G$${lastRow}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${valPts}</c:numCache></c:numRef></c:val>
      </c:ser>
      <c:firstSliceAng val="0"/>
    </c:pieChart>
  </c:plotArea>
  <c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>
  <c:plotVisOnly val="1"/><c:dispBlanksAs val="zero"/>
</c:chart>
<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>
</c:chartSpace>`;
}

function buildChartDrawingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <xdr:twoCellAnchor moveWithCells="0" sizeWithCells="0">
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>32</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

async function injectNativePieChart(buffer, classesToShow, initialValues, initialTitle) {
  if (typeof JSZip === "undefined") { console.warn("JSZip not loaded — chart not injected"); return buffer; }
  try {
    const zip = await JSZip.loadAsync(buffer);

    // Locate the Charts sheet — attributes may appear in any order, so find the
    // full element first, then extract r:id from it.
    const wbXml = await zip.file("xl/workbook.xml").async("text");
    const wbRels = await zip.file("xl/_rels/workbook.xml.rels").async("text");
    const sheetElMatch = wbXml.match(/<sheet\b[^/]*?name="Charts"[^/]*?\/>/);
    if (!sheetElMatch) throw new Error("Charts sheet element not found in workbook.xml");
    const chartsRId = (sheetElMatch[0].match(/r:id="([^"]+)"/) || [])[1];
    if (!chartsRId) throw new Error("Charts sheet r:id not found");
    const relMatch = new RegExp(`Id="${chartsRId}"[^>]+Target="([^"]+)"`).exec(wbRels);
    if (!relMatch) throw new Error("Charts sheet target not found in workbook.xml.rels");
    const sheetTarget = relMatch[1];          // "worksheets/sheet4.xml"
    const sheetPath = `xl/${sheetTarget}`;
    const sheetFile = sheetTarget.replace("worksheets/", ""); // "sheet4.xml"
    const sheetRelsPath = `xl/worksheets/_rels/${sheetFile}.rels`;

    // Add chart and drawing files
    zip.file("xl/charts/chart1.xml", buildNativePieChartXml(classesToShow, initialTitle, initialValues));
    zip.file("xl/drawings/drawing1.xml", buildChartDrawingXml());
    zip.file("xl/drawings/_rels/drawing1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>` +
      `</Relationships>`
    );

    // [Content_Types].xml — add overrides for chart and drawing
    let ct = await zip.file("[Content_Types].xml").async("text");
    if (!ct.includes("drawingml.chart")) {
      ct = ct.replace("</Types>",
        `<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
        `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` +
        `</Types>`
      );
      zip.file("[Content_Types].xml", ct);
    }

    // Charts sheet XML — insert <drawing r:id="rId_d1"/> before <extLst> (if
    // present) or before </worksheet>. Per OOXML spec drawing must precede extLst.
    let sheetXml = await zip.file(sheetPath).async("text");
    if (!sheetXml.includes("<drawing")) {
      if (sheetXml.includes("<extLst>")) {
        sheetXml = sheetXml.replace("<extLst>", `<drawing r:id="rId_d1"/><extLst>`);
      } else {
        sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="rId_d1"/></worksheet>`);
      }
      zip.file(sheetPath, sheetXml);
    }

    // Charts sheet .rels — link drawing
    const existingRels = zip.file(sheetRelsPath);
    let sheetRels = existingRels ? await existingRels.async("text") : null;
    const drawingRel = `<Relationship Id="rId_d1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;
    if (sheetRels) {
      if (!sheetRels.includes("drawings/drawing1")) {
        sheetRels = sheetRels.replace("</Relationships>", `${drawingRel}</Relationships>`);
      }
    } else {
      sheetRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `${drawingRel}</Relationships>`;
    }
    zip.file(sheetRelsPath, sheetRels);

    return await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  } catch (e) {
    console.error("Native chart injection failed:", e);
    return buffer;
  }
}

/**
 * Renders Chart.js off-screen (native Excel charts are not available from browser APIs;
 * embedded PNGs open correctly in Excel / LibreOffice).
 */
async function renderChartJsToDataUrl(chartConfig, width, height) {
  if (typeof Chart === "undefined" || !chartConfig) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0.01;";
  document.body.appendChild(canvas);
  try {
    const ctx = canvas.getContext("2d");
    const { type, data, options: innerOpts } = chartConfig;
    const chart = new Chart(ctx, {
      type,
      data,
      options: {
        responsive: false,
        maintainAspectRatio: false,
        devicePixelRatio: 2,
        animation: false,
        ...(innerOpts || {}),
      },
    });
    chart.update("none");
    const dataUrl = canvas.toDataURL("image/png");
    chart.destroy();
    return dataUrl;
  } catch (e) {
    console.warn("Chart.js render for Excel export failed", e);
    return null;
  } finally {
    canvas.remove();
  }
}

async function writeLandCoverWorkbookExcelJs(filename, byYear, byClass, infoAoa, chartCtx) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lithuania land cover dashboard";
  wb.created = new Date();

  const wsY = wb.addWorksheet("By year");
  applyExcelJsLandCoverSheet(wsY, byYear);

  const wsC = wb.addWorksheet("By class");
  applyExcelJsLandCoverSheet(wsC, byClass);

  const wsI = wb.addWorksheet("Export info");
  wsI.getColumn(1).width = 22;
  wsI.getColumn(2).width = 72;
  infoAoa.forEach((row, ri) => {
    const r = wsI.getRow(ri + 1);
    row.forEach((v, ci) => {
      r.getCell(ci + 1).value = v === undefined || v === null ? "" : v;
    });
  });

  const fig = wb.addWorksheet("Charts");
  const classes = chartCtx?.classes ?? [];
  const shareByYear = chartCtx?.byYear ?? {};
  const exportYears = chartCtx?.years ?? [];
  const latestYear = chartCtx?.latestYear ?? exportYears[exportYears.length - 1];
  const titleSuffix =
    chartCtx?.scope === "basin" && chartCtx?.basinName
      ? `(${chartCtx.basinName})`
      : "(national)";

  let anchorRow = 0.3;
  fig.getCell(1, 1).value = `Pie — latest exported year (${latestYear})`;
  fig.getCell(1, 1).font = { bold: true, size: 12 };

  const pieCfg = buildPieChartConfig(classes, shareByYear, latestYear, titleSuffix);
  if (pieCfg && classes.length) {
    const pieUrl = await renderChartJsToDataUrl(pieCfg, 580, 440);
    if (pieUrl) {
      const id = wb.addImage({ base64: pieUrl.split(",")[1], extension: "png" });
      fig.addImage(id, { tl: { col: 0, row: anchorRow }, ext: { width: 520, height: 400 } });
      anchorRow += 24;
    } else {
      fig.getCell(3, 1).value = "(Pie chart could not be rendered.)";
      anchorRow = 4;
    }
  } else {
    fig.getCell(3, 1).value = "(No non-zero classes for pie chart.)";
    anchorRow = 4;
  }

  const titleRow = Math.ceil(anchorRow) + 1;
  fig.getCell(titleRow, 1).value = "Line — class share (%) vs year";
  fig.getCell(titleRow, 1).font = { bold: true, size: 12 };
  anchorRow = titleRow + 0.3;

  const lineCfg = buildLineChartConfig(classes, shareByYear, exportYears, titleSuffix);
  if (lineCfg && classes.length && exportYears.length) {
    const lineUrl = await renderChartJsToDataUrl(lineCfg, 780, 420);
    if (lineUrl) {
      const id2 = wb.addImage({ base64: lineUrl.split(",")[1], extension: "png" });
      fig.addImage(id2, { tl: { col: 0, row: anchorRow }, ext: { width: 700, height: 400 } });
    } else {
      fig.getCell(Math.ceil(anchorRow) + 2, 1).value = "(Line chart could not be rendered.)";
    }
  } else {
    fig.getCell(Math.ceil(anchorRow) + 2, 1).value = "(Not enough data for line chart.)";
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Lithuania bounds (WGS84), same as map maxBounds — used for full-map export framing */
/**
 * After fitBounds / setView, wait for Leaflet + tiles/raster to settle before html2canvas.
 */
function waitMapSettled(map, timeoutMs = 1600, postRafDelayMs = 450) {
  return new Promise((resolve) => {
    if (!map) {
      resolve();
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(tid);
      map.off("moveend zoomend", onIdle);
      map.invalidateSize(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, postRafDelayMs);
        });
      });
    };
    const onIdle = () => done();
    map.on("moveend zoomend", onIdle);
    const tid = setTimeout(done, timeoutMs);
    map.invalidateSize(false);
  });
}

/**
 * Excel (or CSV) from Filters: year range, optional sub-basin, optional class.
 * — National: timeseries CSV only, all years in range (or all years if From/To empty).
 * — Sub-basin: zonal CSV for that basin; years from zonal keys, filtered by range or all if empty.
 */
function buildCombinedChartCtx(datasetKey, years, basinIndices, selectedClasses) {
  if (!years.length) return null;
  const latestYear = years[years.length - 1];
  const allClassLabels = nationalDistributionClassLabels(datasetKey);
  const allClassesSelected = selectedClasses.length >= CANONICAL_CLASSES.length;
  const classes = allClassLabels.filter((c) => {
    const canonical = c === "Natural (residual)" ? "Forest" : c;
    return selectedClasses.includes(canonical) || selectedClasses.includes(c);
  });

  if (!basinIndices || !basinIndices.length) {
    // National CSV has no total-pixel denominator, so no Unclassified row possible here
    const data = state[datasetKey];
    if (!data?.length) return null;
    const byYear = {};
    years.forEach((year) => {
      const rows = data.filter((r) => r.year === year);
      const agg = {};
      rows.forEach((r) => { agg[r.class_name] = (agg[r.class_name] || 0) + r.count; });
      const tot = classes.reduce((s, c) => s + (agg[c] || 0), 0);
      const row = {};
      classes.forEach((c) => { row[c] = tot > 0 ? ((agg[c] || 0) / tot) * 100 : 0; });
      byYear[year] = row;
    });
    return { classes, byYear, latestYear, scope: "national" };
  }

  const index = state.subbasinZonal[datasetKey];
  if (!(index instanceof Map)) return null;
  const byYear = {};
  years.forEach((year) => {
    let totalPx = 0;
    let sumAllClassifiedPx = 0;
    const aggCounts = {};
    basinIndices.forEach((bi) => {
      const cell = index.get(`${bi}|${year}`);
      if (cell && cell.total > 0) {
        totalPx += cell.total;
        sumAllClassifiedPx += [1, 2, 3, 4, 5].reduce((s, id) => s + (cell.counts[id] || 0), 0);
        classes.forEach((c) => {
          const id = NAME_TO_CLASS_ID[c === "Natural (residual)" ? "Forest" : c];
          if (id) aggCounts[c] = (aggCounts[c] || 0) + (cell.counts[id] || 0);
        });
      }
    });
    const row = {};
    classes.forEach((c) => { row[c] = totalPx > 0 ? ((aggCounts[c] || 0) / totalPx) * 100 : 0; });
    if (allClassesSelected && totalPx > 0) {
      const unclassifiedPx = totalPx - sumAllClassifiedPx;
      if (unclassifiedPx > 0) row["Unclassified"] = (unclassifiedPx / totalPx) * 100;
    }
    byYear[year] = row;
  });
  const chartClasses = allClassesSelected ? [...classes, "Unclassified"] : classes;
  return { classes: chartClasses, byYear, latestYear, scope: "basin" };
}

function buildCombinedSummaryAoa(datasetKey, years, scopes, selectedClasses, rowLabel = "All Lithuania (combined)") {
  const index = state.subbasinZonal[datasetKey];
  if (!(index instanceof Map)) return null;
  const allClassesSelected = selectedClasses.length >= CANONICAL_CLASSES.length;
  const allClassLabels = nationalDistributionClassLabels(datasetKey);
  const classesToShow = allClassLabels.filter((c) => selectedClasses.includes(c) || selectedClasses.includes(c === "Natural (residual)" ? "Forest" : c));

  const aoa = [EXPORT_HEADER.slice()];
  let rowCount = 0;

  years.forEach((year, yi) => {
    let totalPx = 0;
    let sumAllClassifiedPx = 0;
    let sumSelectedClassifiedPx = 0;
    const aggCounts = {};

    scopes.forEach((scope) => {
      if (!Number.isFinite(scope.basinIndex)) return;
      const cell = index.get(`${scope.basinIndex}|${year}`);
      if (!cell || cell.total <= 0) return;
      totalPx += cell.total;
      sumAllClassifiedPx += [1, 2, 3, 4, 5].reduce((s, id) => s + (cell.counts[id] || 0), 0);
      classesToShow.forEach((cls) => {
        const id = NAME_TO_CLASS_ID[cls === "Natural (residual)" ? "Forest" : cls] ?? NAME_TO_CLASS_ID[cls];
        if (id) {
          const cnt = cell.counts[id] || 0;
          aggCounts[cls] = (aggCounts[cls] || 0) + cnt;
          sumSelectedClassifiedPx += cnt;
        }
      });
    });

    if (totalPx > 0) {
      classesToShow.forEach((cls) => {
        const cnt = aggCounts[cls] || 0;
        const pctTotal = (cnt / totalPx) * 100;
        // Pct_of_classified: share among only the selected classes
        const pctClassified = sumSelectedClassifiedPx > 0 ? (cnt / sumSelectedClassifiedPx) * 100 : 0;
        aoa.push([rowLabel, cls, cnt, Number(pctTotal.toFixed(4)), Number(pctClassified.toFixed(4)), datasetKey, year]);
        rowCount++;
      });
      if (allClassesSelected) {
        const unclassifiedCnt = totalPx - sumAllClassifiedPx;
        if (unclassifiedCnt > 0) {
          const pctTotal = (unclassifiedCnt / totalPx) * 100;
          aoa.push(["All Lithuania (combined)", "Unclassified", unclassifiedCnt, Number(pctTotal.toFixed(4)), "", datasetKey, year]);
          rowCount++;
        }
      }
    }

    if (yi < years.length - 1) aoa.push(new Array(EXPORT_HEADER.length).fill(""));
  });

  return { aoa, rowCount };
}

async function exportLandCoverSummaryXlsx() {
  const datasetKey = document.getElementById("dataset-select")?.value || "hildaknn";
  const selectedClasses = getSelectedClassNames();
  const basinIndices = getSelectedBasinIndices(); // null = national

  if (!state[datasetKey]?.length) {
    showToast("No timeseries data loaded for this dataset.", "warning");
    return;
  }

  // Build scopes list — "All Lithuania" now means one sheet per sub-basin
  let scopes;
  const allBasinCbs = Array.from(document.querySelectorAll(".basin-cb"));
  if (!basinIndices || !basinIndices.length) {
    // All Lithuania selected: one sheet per every loaded basin
    if (!allBasinCbs.length) {
      // Basin GeoJSON not yet loaded — can't produce per-basin sheets
      showToast("Basin data is not yet loaded. Wait for the map to finish loading, then try again.", "warning");
      return;
    }
    await ensureSubbasinZonalLoaded(datasetKey);
    if (!(state.subbasinZonal[datasetKey] instanceof Map)) {
      showToast("Sub-basin export requires zonal statistics for this dataset.", "warning");
      return;
    }
    const usedLabels = new Set();
    scopes = allBasinCbs.map((cb) => {
      const i = parseInt(cb.value, 10);
      const raw = cb.dataset?.basinName || `Basin_${i + 1}`;
      let label = raw.slice(0, 28);
      // Deduplicate sheet tab names
      if (usedLabels.has(label)) label = `${label.slice(0, 24)}_${i}`.slice(0, 31);
      usedLabels.add(label);
      return { label, basinIndex: i, basinName: raw };
    });
  } else {
    await ensureSubbasinZonalLoaded(datasetKey);
    if (!(state.subbasinZonal[datasetKey] instanceof Map)) {
      showToast("Sub-basin export requires zonal statistics for this dataset.", "warning");
      return;
    }
    scopes = basinIndices.map((i) => {
      const cb = document.querySelector(`.basin-cb[value="${i}"]`);
      const name = cb?.dataset?.basinName || `Basin_${i + 1}`;
      return { label: name.slice(0, 28), basinIndex: i, basinName: name };
    });
  }

  const firstBasinIndex = scopes[0].basinIndex;
  const { years, error } = resolveExportYears(datasetKey, firstBasinIndex);
  if (error === "range_empty") {
    showToast("No years fall in the selected range. Widen the Year range (From/To) and try again.", "warning");
    return;
  }
  if (error === "basin_years") { showToast("No zonal statistics found for the selected basin(s).", "warning"); return; }
  if (error === "national_years") { showToast("No national years available for this dataset.", "warning"); return; }
  if (!years.length) { showToast("Nothing to export for the current filters.", "warning"); return; }

  const safeDs = datasetKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const y0 = years[0], y1 = years[years.length - 1];
  const yearTag = years.length === 1 ? String(y0) : `${y0}-${y1}`;
  const filename = `landcover_${safeDs}_${yearTag}.xlsx`;

  if (typeof ExcelJS !== "undefined" && ExcelJS.Workbook) {
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = "Lithuania land cover dashboard";
      wb.created = new Date();

      // Combined summary sheet \u2014 first tab, only when multiple scopes.
      // Label depends on whether all Lithuania or only specific basins are exported.
      if (scopes.length > 1) {
        const isAllLithuania = !basinIndices || !basinIndices.length;
        const combinedSheetName = isAllLithuania ? "All Lithuania" : `${scopes.length} basins combined`;
        const combinedRowLabel = isAllLithuania
          ? "All Lithuania (combined)"
          : `${scopes.length} selected basins (combined)`;
        const combined = buildCombinedSummaryAoa(datasetKey, years, scopes, selectedClasses, combinedRowLabel);
        if (combined && combined.rowCount > 0) {
          const wsCombined = wb.addWorksheet(combinedSheetName.slice(0, 31));
          applyExcelJsLandCoverSheetStyled(wsCombined, combined.aoa);
        }
      }

      // One sheet per basin scope \u2014 rows already filtered to selectedClasses inside buildExportDataAoas
      for (const scope of scopes) {
        const { byYear, rowCount } = buildExportDataAoas(datasetKey, years, scope.basinIndex, scope.basinName, selectedClasses);
        if (!rowCount) continue;
        const ws = wb.addWorksheet((scope.label || "National").slice(0, 31));
        applyExcelJsLandCoverSheetStyled(ws, byYear);
      }

      // Charts sheet \u2014 interactive pie chart with Year/Scope dropdowns
      // Scopes: national + ALL sub-basins (zonal data is already loaded above)
      const chartScopes = [
        { name: "Lithuania (national)", basinIndex: NaN },
        ...allBasinCbs.map((cb) => ({
          name: cb.dataset.basinName || `Basin ${Number(cb.value) + 1}`,
          basinIndex: parseInt(cb.value, 10),
        })),
      ];
      const { flatRows, classesToShow } = buildChartsWorksheetFormulaDriven(wb, datasetKey, years, chartScopes, selectedClasses);

      // Info sheet
      const wsI = wb.addWorksheet("Export info");
      wsI.getColumn(1).width = 24; wsI.getColumn(2).width = 72;
      buildExportInfoAoaMulti(datasetKey, years, scopes, selectedClasses).forEach((row, ri) => {
        const r = wsI.getRow(ri + 1);
        row.forEach((v, ci) => { r.getCell(ci + 1).value = v ?? ""; });
        if (ri === 0) r.getCell(1).font = { bold: true, size: 12 };
      });

      // Force full recalculation when the file is opened in Excel so the
      // SUMPRODUCT formulas (chart data source) evaluate immediately.
      try { wb.calcProperties.fullCalcOnLoad = true; } catch (_) {}

      // Pre-compute initial chart values (default scope + last year) so the
      // chart cache has real data and the pie shows on first open.
      const defaultYear = years[years.length - 1];
      const initialValues = buildInitialChartValues(flatRows, classesToShow, chartScopes[0].name, defaultYear);
      const initialTitle = `${chartScopes[0].name} \u2014 Year: ${defaultYear}`;

      // Write ExcelJS buffer, then inject native pie chart XML via JSZip
      const baseBuffer = await wb.xlsx.writeBuffer();
      const finalBuffer = await injectNativePieChart(baseBuffer, classesToShow, initialValues, initialTitle);
      const blob = new Blob([finalBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
      return;
    } catch (e) {
      console.warn("ExcelJS export failed, falling back to CSV:", e);
    }
  }

  // CSV fallback \u2014 rows already filtered to selectedClasses inside buildExportDataAoas
  const { byYear: csvRows } = buildExportDataAoas(datasetKey, years, firstBasinIndex, scopes[0].basinName, selectedClasses);
  downloadTextFile(filename.replace(/\.xlsx$/i, ".csv"), "\uFEFF" + csvRows.map((r) => r.map((c) => escapeCsvCell(c)).join(",")).join("\r\n"), "text/csv;charset=utf-8");
}

function setupMapExport() {
  const mapContainer = document.querySelector(".map-container");
  if (!mapContainer || typeof html2canvas === "undefined") return;

  // Crop a captured dataUrl to a CSS-pixel rect at the given capture pixel-ratio.
  function cropDataUrl(dataUrl, rect, pr) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width  = Math.round(rect.w * pr);
        c.height = Math.round(rect.h * pr);
        c.getContext("2d").drawImage(
          img,
          Math.round(rect.x * pr), Math.round(rect.y * pr),
          Math.round(rect.w * pr), Math.round(rect.h * pr),
          0, 0, c.width, c.height
        );
        resolve(c.toDataURL("image/png"));
      };
      img.src = dataUrl;
    });
  }

  /**
   * Snapshot #map — prefer html-to-image (Leaflet panes use translate3d; html2canvas often misaligns SVG vs tiles).
   * cropRect (optional) — { x, y, w, h } in CSS pixels to tightly frame the output.
   */
  async function captureAndDownload(filename, pixelRatio, cropRect) {
    const pr = pixelRatio || 2.5;
    const map = state.map.instance;

    // Hide UI controls that must not appear in the exported image.
    const hideEls = [
      mapContainer.querySelector(".leaflet-control-zoom"),
      mapContainer.querySelector(".leaflet-control-recenter"),
      mapContainer.querySelector(".map-loading"),
    ].filter(Boolean);
    hideEls.forEach((el) => { el.style.visibility = "hidden"; });

    let restoreTooltips = () => {};
    if (map) {
      const pane = map.getPane("tooltipPane");
      if (pane) {
        const prev = pane.style.visibility;
        pane.style.visibility = "hidden";
        restoreTooltips = () => {
          pane.style.visibility = prev;
        };
      }
    }
    // html-to-image serializes to a foreignObject SVG where url(#id) clip-path references
    // lose their ID resolution. Temporarily swap to an inline path() so the captured image
    // matches exactly what's on screen, then restore the url() reference afterward.
    const rasterPane = map?.getPanes?.()?.rasterPane;
    const clipPathEl = document.querySelector("#basin-clip-path path");
    let prevClipPath = null;
    if (rasterPane?.style.clipPath.includes("url(") && clipPathEl) {
      prevClipPath = rasterPane.style.clipPath;
      const d = clipPathEl.getAttribute("d") || "";
      rasterPane.style.clipPath = d ? `path("${d}")` : "";
    }
    try {
      let dataUrl;
      const hi = typeof window !== "undefined" && window.htmlToImage ? window.htmlToImage : null;
      if (hi && typeof hi.toPng === "function") {
        try {
          dataUrl = await hi.toPng(mapContainer, {
            cacheBust: true,
            pixelRatio: pr,
            backgroundColor: "#f8fafc",
          });
        } catch (e) {
          console.warn("html-to-image failed, falling back to html2canvas", e);
        }
      }
      if (!dataUrl) {
        const canvas = await html2canvas(mapContainer, {
          useCORS: true,
          allowTaint: true,
          backgroundColor: "#f8fafc",
          scale: pr,
          logging: false,
        });
        dataUrl = canvas.toDataURL("image/png");
      }
      if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
        dataUrl = await cropDataUrl(dataUrl, cropRect, pr);
      }
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
    } finally {
      hideEls.forEach((el) => { el.style.visibility = ""; });
      if (prevClipPath !== null && rasterPane) {
        rasterPane.style.clipPath = prevClipPath;
      }
      restoreTooltips();
    }
  }

  async function runExport(kind) {
    const ds = document.getElementById("dataset-select")?.value || "map";
    const yEl = document.getElementById("year-label");
    const yr =
      (yEl?.dataset?.rasterYear && String(yEl.dataset.rasterYear)) ||
      (yEl?.textContent?.match(/^(\d{4})/)?.[1] ?? "");

    if (kind === "map-auto") {
      const bi = getSelectedBasinIndices();
      kind = (Array.isArray(bi) && bi.length > 0) ? "basin-png" : "map-png";
    }

    if (kind === "map-png") {
      const map = state.map.instance;
      if (!map) {
        await captureAndDownload(`lithuania_landcover_${ds}_${yr || "full"}.png`, 3.25, null);
        return;
      }

      // Temporarily thin basin outlines — at country-level zoom the normal weights look too heavy.
      const gj = state.map.subbasins;
      if (state.map.basinLayer && gj) {
        state.map.basinLayer.setStyle((feature) => {
          const idx = gj.features.indexOf(feature);
          const sel = state.map.selectedBasinIndices;
          const selected = Array.isArray(sel) && sel.includes(idx);
          const sat = state.map.opts.baseMap === "satellite";
          if (selected) return { ...(sat ? BASIN_STYLE_SELECTED_SAT : BASIN_STYLE_SELECTED), weight: 1.5 };
          return { ...(sat ? BASIN_STYLE_DEFAULT_SAT : BASIN_STYLE_DEFAULT), weight: 0.75 };
        });
      }

      // Capture exactly the view the user currently has on screen — no forced
      // re-fit to Lithuania's bounds. That reset was harmless while the map was
      // locked to Lithuania (panning couldn't go anywhere else anyway), but now
      // that panning/zooming is free, silently snapping away and back before the
      // screenshot meant the exported image didn't match what was on screen.
      await captureAndDownload(`lithuania_landcover_${ds}_${yr || "full"}.png`, 3.25, null);
      applyBasinOutlineHighlight(state.map.selectedBasinIndices); // restore weights
      return;
    }

    if (kind === "basin-png") {
      const basinIndices = getSelectedBasinIndices();
      if (!basinIndices || basinIndices.length === 0) {
        await runExport("map-png");
        return;
      }
      const map = state.map.instance;

      // Compute combined bounds across all selected basins.
      let combined = null;
      basinIndices.forEach((i) => {
        const ly = getBasinLeafletLayer(i);
        if (ly?.getBounds) combined = combined ? combined.extend(ly.getBounds()) : ly.getBounds();
      });
      if (!combined) { await runExport("map-png"); return; }

      // Build a filename from the selected basin(s).
      let basinLabel;
      if (basinIndices.length === 1) {
        const cb = document.querySelector(`.basin-cb[value="${basinIndices[0]}"]`);
        const raw = cb?.dataset?.basinName || `Basin_${basinIndices[0] + 1}`;
        basinLabel = raw.replace(/[^a-zA-Z0-9\u0080-\u024F\s-]/g, "").replace(/\s+/g, "_");
      } else {
        basinLabel = `${basinIndices.length}_basins`;
      }

      // Temporarily thin basin outlines \u2014 same as map-png export.
      const gj = state.map.subbasins;
      if (state.map.basinLayer && gj) {
        state.map.basinLayer.setStyle((feature) => {
          const idx = gj.features.indexOf(feature);
          const sel = state.map.selectedBasinIndices;
          const selected = Array.isArray(sel) && sel.includes(idx);
          const sat = state.map.opts.baseMap === "satellite";
          if (selected) return { ...(sat ? BASIN_STYLE_SELECTED_SAT : BASIN_STYLE_SELECTED), weight: 1.5 };
          return { ...(sat ? BASIN_STYLE_DEFAULT_SAT : BASIN_STYLE_DEFAULT), weight: 0.75 };
        });
      }

      const center = map.getCenter();
      const zoom = map.getZoom();
      fitMapToBounds(map, combined.pad(0.06), { maxZoom: 18 });
      await waitMapSettled(map, 1800, 480);

      // Crop tightly to the basin bounds so the image isn't mostly empty map.
      const nwPx = map.latLngToContainerPoint(combined.getNorthWest());
      const sePx = map.latLngToContainerPoint(combined.getSouthEast());
      const margin = 20;
      const cropRect = {
        x: Math.max(0, nwPx.x - margin),
        y: Math.max(0, nwPx.y - margin),
        w: Math.min(mapContainer.offsetWidth,  sePx.x - nwPx.x + margin * 2),
        h: Math.min(mapContainer.offsetHeight, sePx.y - nwPx.y + margin * 2),
      };

      await captureAndDownload(`${basinLabel}_${ds}_${yr || "full"}.png`, 3, cropRect);
      map.setView(center, zoom, { animate: false });
      map.invalidateSize(false);
      applyBasinOutlineHighlight(state.map.selectedBasinIndices); // restore weights
      return;
    }

    if (kind === "excel-xlsx") {
      const hint = document.getElementById("map-overlay-hint");
      if (hint) hint.textContent = "Building summary workbook…";
      try {
        await exportLandCoverSummaryXlsx();
      } finally {
        if (hint) {
          const r = document.getElementById("year-label")?.dataset?.rasterYear;
          hint.textContent = r ? `GeoTIFF: ${r}` : "";
        }
      }
    }
  }

  document.getElementById("export-analysis-btn")?.addEventListener("click", () => void runExport("excel-xlsx"));
  document.getElementById("export-map-btn")?.addEventListener("click", () => void runExport("map-auto"));
}

// CORINE 5-class colors (match export)
const CORINE_COLORS = {
  1: "#4DA6FF", // Water
  2: "#7B68EE", // Wetland
  3: "#FF4D4D", // Urban
  4: "#FFD24D", // Agriculture
  5: "#228B22", // Forest
};

// Pre-indexed color lookup: CORINE_COLORS_ARR[v] = CSS color for class v (1-5), null for nodata.
const CORINE_COLORS_ARR = [null, ...Object.values(CORINE_COLORS)]; // [null, c1, c2, c3, c4, c5]

// Build a pixel function with class filter baked into a 6-slot lookup array.
// Called once per layer (or per redraw), NOT once per pixel.
function makePixelFn(selectedClassIds) {
  const classSet = Array.isArray(selectedClassIds) && selectedClassIds.length > 0
    && selectedClassIds.length < CANONICAL_CLASSES.length
    ? new Set(selectedClassIds) : null;
  const lookup = CORINE_COLORS_ARR.map((c, i) =>
    i === 0 ? null : (!classSet || classSet.has(i)) ? (c || null) : null
  );
  // Hot path: called millions of times per render.
  // v >= 1 safely returns false for null, undefined, NaN, and 0.
  return (values) => {
    const v = values[0];
    return (v >= 1 && v <= 5) ? lookup[v] : null;
  };
}

function makeLandcoverRasterLayer(georaster, opacity, selectedClassIds, datasetKey) {
  const resolution = DATASET_REGISTRY[datasetKey]?.renderResolution ?? 512;
  const isTiled = TILED_DATASETS.has(datasetKey);
  return new GeoRasterLayer({
    georaster,
    pane: "rasterPane",
    opacity: opacity !== undefined ? opacity : 0.65,
    resolution,
    // Don't re-render tiles during the zoom animation — Leaflet will CSS-scale
    // the existing tiles and only create new ones once the gesture ends.
    updateWhenZooming: false,
    // Tiled datasets (esri/grpk) already manage their own viewport buffer at
    // the cell level (see updateTiledRasterOverlay's bounds padding) — an additional internal
    // Leaflet tile buffer here just multiplies how many (expensive) tiles
    // each of the several per-cell layers tries to generate the moment
    // it's added, which is what made adding a layer at deep zoom take
    // seconds and let the map fall behind the user's actual zoom level.
    keepBuffer: isTiled ? 0 : 2,
    // georaster-layer-for-leaflet caches drawn tiles on GeoRasterLayer.prototype.cache
    // -- a SINGLE object shared by every instance ever created on the page -- keyed only
    // by tile x/y/z and resolution, with no reference to which georaster/dataset/year drew
    // it. A fresh layer for a new year, at a viewport whose tiles were already cached by
    // the previous year's layer (i.e. any year change without an intervening pan/zoom),
    // gets served the OLD layer's stale canvases and never redraws at all. Disabling this
    // is cheap: getGeorasterCached() above already avoids re-fetching/re-parsing the GeoTIFF
    // itself, so this only skips reusing an already-composited tile canvas.
    caching: false,
    pixelValuesToColorFn: makePixelFn(selectedClassIds),
    // window.TILED_DEBUG=true unlocks georaster-layer-for-leaflet's own verbose
    // per-tile logging (subextents overlap, computed resolution, tile bounds) —
    // used to diagnose the "Esri layer renders then vanishes after zoom" report.
    debugLevel: typeof window !== "undefined" && window.TILED_DEBUG ? 2 : 0,
  });
}

function buildSvgPathData(geom, map) {
  let rings = [];
  if (geom.type === "Polygon") {
    rings = geom.coordinates;
  } else if (geom.type === "MultiPolygon") {
    geom.coordinates.forEach((poly) => rings.push(...poly));
  }
  return rings
    .map((ring) => {
      const pts = ring.map(([lng, lat]) => {
        // latLngToLayerPoint gives coordinates in the map pane's local space,
        // which matches the overlay pane's coordinate system for clip-path.
        // latLngToContainerPoint would include the pane's CSS transform offset
        // and produce a misaligned clip.
        const p = map.latLngToLayerPoint(L.latLng(lat, lng));
        return `${p.x},${p.y}`;
      });
      if (pts.length === 0) return "";
      return `M ${pts[0]} L ${pts.slice(1).join(" L ")} Z`;
    })
    .join(" ");
}

function applyOverlayPaneMask(basinFeatures, map) {
  clearOverlayPaneMask(map);

  const overlayPane = map.getPanes().rasterPane;
  const features = Array.isArray(basinFeatures) ? basinFeatures.filter((f) => f?.geometry) : [];
  if (!overlayPane || !features.length) return;

  const svgNS = "http://www.w3.org/2000/svg";
  const container = map.getContainer();

  let maskSvg = document.getElementById("basin-mask-svg");
  if (!maskSvg) {
    maskSvg = document.createElementNS(svgNS, "svg");
    maskSvg.id = "basin-mask-svg";
    maskSvg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0;";
    container.appendChild(maskSvg);
  }

  let defs = maskSvg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(svgNS, "defs");
    maskSvg.appendChild(defs);
  }

  const existingClip = document.getElementById("basin-clip-path");
  if (existingClip) existingClip.parentNode.removeChild(existingClip);

  const clipPath = document.createElementNS(svgNS, "clipPath");
  clipPath.id = "basin-clip-path";
  clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");

  const pathEl = document.createElementNS(svgNS, "path");
  clipPath.appendChild(pathEl);
  defs.appendChild(clipPath);

  let clipRafId = null;
  function updateClip() {
    if (clipRafId !== null) return; // already scheduled for this frame
    clipRafId = requestAnimationFrame(() => {
      clipRafId = null;
      pathEl.setAttribute("d", features.map((f) => buildSvgPathData(f.geometry, map)).join(" "));
    });
  }

  updateClip();
  overlayPane.style.clipPath = "url(#basin-clip-path)";

  map.on("move zoom viewreset moveend zoomend", updateClip);
  state.map.maskCleanup = () => {
    map.off("move zoom viewreset moveend zoomend", updateClip);
    if (clipRafId !== null) { cancelAnimationFrame(clipRafId); clipRafId = null; }
  };
}

function clearOverlayPaneMask(map) {
  if (state.map.maskCleanup) {
    state.map.maskCleanup();
    state.map.maskCleanup = null;
  }
  const overlayPane = map?.getPanes?.()?.rasterPane;
  if (overlayPane) overlayPane.style.clipPath = "";
  const maskSvg = document.getElementById("basin-mask-svg");
  if (maskSvg) maskSvg.parentNode.removeChild(maskSvg);
}

function setMapLoading(active) {
  document.getElementById("map-loading")?.classList.toggle("active", active);
}

// ── Zoom/viewport-aware tiling ───────────────────────────────────────────
// Esri (10m native) and GRPK (vector cadastre, no fixed native resolution)
// are too precise to load as one flat whole-country file at every zoom
// level — instead each is pre-split (see analysis/export_esri_tiles.py and
// analysis/export_grpk_tiles.py) into three zoom-dependent tiers:
//   national — whole country, one coarse file (default/zoomed-out view)
//   regional — a small geographic grid, medium resolution
//   close    — a finer geographic grid, true native resolution (raster for
//              Esri; actual vector polygons for GRPK) — only the grid
//              cell(s) under the current viewport are ever fetched.
// All other datasets are unaffected and keep using the flat-file path below.
const TILED_DATASETS = new Set(["esri", "grpk"]);

/** Shared debounce for "please re-check the tiled overlay" requests, used by
 * BOTH the zoomend/moveend map listener AND the staleness-recovery path
 * inside updateTiledRasterOverlay. This coalescing is essential: an earlier
 * version had each stale call independently fire off its own immediate
 * restart, and since restarting itself bumps the shared sequence counter,
 * two or more overlapping restarts would perpetually invalidate EACH OTHER
 * — an infinite loop that kept running long after the user stopped
 * zooming entirely (confirmed via window.TILED_DEBUG logging showing
 * hundreds of restarts at a zoom level that never changed again). Routing
 * every request through one shared timer means overlapping signals collapse
 * into a single eventual re-check instead of an unbounded cascade. */
let tiledRecheckTimer = null;
function scheduleTiledRecheck(delayMs = 200) {
  clearTimeout(tiledRecheckTimer);
  tiledRecheckTimer = setTimeout(() => {
    const map = state.map.instance;
    const active = state.map.tiledActive;
    if (!map || !active || !TILED_DATASETS.has(active.datasetKey)) {
      tiledLog("tiled recheck fired but nothing active to check");
      return;
    }
    const seq = ++applyFiltersSeq;
    tiledLog(`tiled recheck fired: re-checking ${active.datasetKey} at seq=${seq}`);
    const classIds = active.classIdsKey === "all" ? null : active.classIdsKey.split(",").map(Number);
    updateTiledRasterOverlay(active.datasetKey, active.year, classIds, seq).catch((e) => console.error(e));
  }, delayMs);
}

/** Correctly tears down state.map.tiledLayerGroup. This is NOT the same as
 * `map.removeLayer(state.map.tiledLayerGroup)`: the individual cell layers
 * inside it were added directly to the map (`layer.addTo(map)`) one at a
 * time (see the incremental-add loop in updateTiledRasterOverlay, needed so
 * a mid-zoom staleness check could bail between additions) — the
 * LayerGroup object itself was only ever used as a bookkeeping container
 * (`group.addLayer(layer)`) and was never itself added via `.addTo(map)`.
 * Leaflet's map.removeLayer() no-ops silently for a layer it never
 * registered, so calling it on the group left every cell layer permanently
 * stuck on the map — exactly the "leftover rectangular patch after zooming
 * back out" bug. Removing each child layer individually is what actually
 * detaches them. */
function removeTiledLayerGroup(map) {
  const group = state.map.tiledLayerGroup;
  if (!group) return;
  group.eachLayer((l) => map.removeLayer(l));
  state.map.tiledLayerGroup = null;
}
/** Aborts the previous tiled call's in-flight fetches the moment a newer one
 * starts, so a burst of zoom/pan events doesn't pile up dozens of abandoned
 * requests competing for the browser's limited per-origin connections. */
let tiledFetchController = null;
const TIER_ZOOM_THRESHOLDS = { regional: 9, close: 12 };

function pickTierForZoom(zoom) {
  if (zoom >= TIER_ZOOM_THRESHOLDS.close) return "close";
  if (zoom >= TIER_ZOOM_THRESHOLDS.regional) return "regional";
  return "national";
}

async function getTileManifest(datasetKey) {
  if (state.tileManifests[datasetKey]) return state.tileManifests[datasetKey];
  const url = resolveDataFileUrl(`rasters/${datasetKey}/tiles/manifest.json`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    state.tileManifests[datasetKey] = data;
    return data;
  } catch (e) {
    console.error(`Failed to load tile manifest for ${datasetKey}:`, e);
    return null;
  }
}

/** [row, col] pairs of `grid`-sized cells over `bbox` that intersect the
 * given Leaflet bounds, restricted to cells actually present in
 * `populatedCells` (an array of [row,col] pairs — or a boolean for the
 * single-cell "national" tier, where grid is always 1). */
function cellsForBounds(bbox, grid, bounds, populatedCells) {
  if (grid <= 1) {
    const hasData = Array.isArray(populatedCells) ? populatedCells.length > 0 : !!populatedCells;
    return hasData ? [[0, 0]] : [];
  }
  const { south, west, north, east } = bbox;
  const lonStep = (east - west) / grid;
  const latStep = (north - south) / grid;
  const colMin = Math.max(0, Math.floor((bounds.getWest() - west) / lonStep));
  const colMax = Math.min(grid - 1, Math.floor((bounds.getEast() - west) / lonStep));
  const rowMin = Math.max(0, Math.floor((bounds.getSouth() - south) / latStep));
  const rowMax = Math.min(grid - 1, Math.floor((bounds.getNorth() - south) / latStep));
  const populatedSet = new Set((populatedCells || []).map(([r, c]) => `${r}_${c}`));
  const cells = [];
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (populatedSet.has(`${row}_${col}`)) cells.push([row, col]);
    }
  }
  return cells;
}

function cellsKeyFor(cells) {
  return cells.map(([r, c]) => `${r}_${c}`).sort().join(",");
}

function esriTileUrl(tier, year, row, col) {
  return tier === "national"
    ? resolveDataFileUrl(`rasters/esri/tiles/national/${year}.tif`)
    : resolveDataFileUrl(`rasters/esri/tiles/${tier}/${year}/${row}_${col}.tif`);
}

function grpkRasterTileUrl(tier, row, col) {
  return tier === "national"
    ? resolveDataFileUrl(`rasters/grpk/tiles/national/national.tif`)
    : resolveDataFileUrl(`rasters/grpk/tiles/${tier}/${row}_${col}.tif`);
}

function grpkVectorTileUrl(row, col) {
  return resolveDataFileUrl(`rasters/grpk/tiles/vector/${row}_${col}.geojson`);
}

// Toggle to true in the browser console (window.TILED_DEBUG = true) for a
// verbose trace of every tier/cell decision, fetch, and layer swap — added
// to diagnose the "Esri flashes then disappears after zoom" report.
window.TILED_DEBUG = window.TILED_DEBUG ?? false;
function tiledLog(...args) {
  if (window.TILED_DEBUG) console.log("[Tiled]", ...args);
}

// state.tileGeorasterCache used to grow completely unbounded for the life
// of the page — every parsed vector cell (GRPK's close-tier GeoJSON, some
// cells up to ~40MB on disk and considerably more once parsed into JS
// objects) stayed cached forever. Measured via Chrome's heap usage: visiting
// just ~8 different areas of the country pushed JS heap from ~130MB past
// 2.7GB, which is exactly the kind of unbounded growth that eventually
// crashes the tab — matching reports of the map "sometimes crashing" during
// a longer session of panning/zooming around. Approximate each entry's size
// and evict the least-recently-used ones once a total budget is exceeded,
// instead of capping by entry count (cell sizes vary far too much — from a
// few KB to tens of MB — for a fixed entry count to be a safe bound).
const TILE_CACHE_MAX_BYTES = 300 * 1024 * 1024; // ~300MB budget for cached tiles
let tileCacheBytes = 0;
const tileCacheSizes = new Map(); // url -> approximate byte size, mirrors state.tileGeorasterCache's keys

function tileCacheGet(url) {
  if (!state.tileGeorasterCache.has(url)) return undefined;
  const val = state.tileGeorasterCache.get(url);
  state.tileGeorasterCache.delete(url);
  state.tileGeorasterCache.set(url, val); // re-insert: Map iteration order tracks most-recently-used
  return val;
}

// sizeBytes should be the actual fetched payload size (arrayBuffer.byteLength
// or raw text.length) — cheap and accurate, unlike re-serializing the parsed
// object after the fact (which for a 40MB GeoJSON cell would itself burn a
// noticeable chunk of main-thread time on every cache insert).
function tileCacheSet(url, val, sizeBytes) {
  const size = sizeBytes || 1024 * 1024; // unknown size — assume 1MB rather than 0 so it still counts toward the budget
  state.tileGeorasterCache.set(url, val);
  tileCacheSizes.set(url, size);
  tileCacheBytes += size;
  while (tileCacheBytes > TILE_CACHE_MAX_BYTES && state.tileGeorasterCache.size > 1) {
    const oldestKey = state.tileGeorasterCache.keys().next().value;
    tileCacheBytes -= tileCacheSizes.get(oldestKey) || 0;
    tileCacheSizes.delete(oldestKey);
    state.tileGeorasterCache.delete(oldestKey);
    tiledLog(`tile cache evicted (over ${(TILE_CACHE_MAX_BYTES / 1024 / 1024).toFixed(0)}MB budget):`, oldestKey);
  }
}

async function getGeorasterCachedByUrl(url, signal) {
  const cached = tileCacheGet(url);
  if (cached) return cached;
  let resp;
  try {
    resp = await fetch(url, { signal });
  } catch (e) {
    if (e.name === "AbortError") { tiledLog("fetch aborted (superseded):", url); return null; }
    throw e;
  }
  if (!resp.ok) { tiledLog("fetch non-OK", resp.status, url); return null; }
  const buf = await resp.arrayBuffer();
  if (typeof parseGeoraster === "undefined") return null;
  const gr = await parseGeoraster(buf);
  if (gr) tileCacheSet(url, gr, buf.byteLength);
  return gr;
}

const GRPK_VECTOR_CLASS_COLORS = {
  Water: "#4DA6FF",
  Wetland: "#7B68EE",
  Urban: "#FF4D4D",
  Agriculture: "#FFD24D",
  Forest: "#228B22",
};

// One shared canvas renderer for every GRPK vector cell layer. A fresh
// `L.canvas()` per call each gets its own canvas DOM node added to the
// overlay pane on first use, and removing the *layer* later (map.removeLayer
// on the L.geoJSON instance) only clears its paths from that renderer — it
// does not remove the renderer's own canvas element, since renderers are
// designed to be shared/persistent. That left one orphaned blank canvas
// behind per cell ever loaded. Reusing a single instance means there's only
// ever one canvas to begin with, so there's nothing to leak.
const grpkVectorRenderer = L.canvas();

/** GRPK's close-zoom tier: the actual parcel polygons for one grid cell,
 * rendered as a true vector layer (not rasterized) — lossless precision. */
async function loadGrpkVectorLayer(row, col, opacity, classIds, signal) {
  const url = grpkVectorTileUrl(row, col);
  let geojson = tileCacheGet(url); // same bounded cache, parsed GeoJSON this time
  if (!geojson) {
    let resp;
    try {
      resp = await fetch(url, { signal });
    } catch (e) {
      if (e.name === "AbortError") { tiledLog("fetch aborted (superseded):", url); return null; }
      throw e;
    }
    if (!resp.ok) { tiledLog("fetch non-OK", resp.status, url); return null; }
    // Read as text first (not resp.json()) so the actual payload size is
    // known cheaply for the cache's eviction budget — some of these cells
    // are ~40MB, and the fix for the "map sometimes crashes" report depends
    // on evicting the right (largest, oldest) entries before the cache
    // balloons past a few hundred MB.
    const text = await resp.text();
    geojson = JSON.parse(text);
    tileCacheSet(url, geojson, text.length);
  }
  const classSet = classIds && classIds.length ? new Set(classIds) : null;
  return L.geoJSON(geojson, {
    renderer: grpkVectorRenderer,
    style: (feature) => {
      const cid = feature.properties?.class_id;
      const name = feature.properties?.class_name;
      const visible = !classSet || classSet.has(cid);
      return {
        color: "#00000000",
        weight: 0,
        fillColor: visible ? GRPK_VECTOR_CLASS_COLORS[name] || "#94a3b8" : "#00000000",
        fillOpacity: visible ? opacity : 0,
      };
    },
  });
}

/** Builds the Leaflet layers for the current tier/viewport of a tiled
 * dataset without touching the map — mirrors the flat-dataset "prepare then
 * swap" pattern so there's no coexistence window with the old layer. All
 * cells fetch in parallel (not one-by-one) since a viewport can need several
 * chunks at once, especially at the close/native tier. `signal` cancels the
 * in-flight fetches if this call gets superseded before it finishes. */
async function buildTiledLayers(datasetKey, year, classIds, tier, cells, opacity, signal) {
  tiledLog(`buildTiledLayers: ${datasetKey} tier=${tier} cells=${JSON.stringify(cells)}`);
  let cellLayers;
  if (datasetKey === "esri") {
    cellLayers = await Promise.all(
      cells.map(async ([row, col]) => {
        const gr = await getGeorasterCachedByUrl(esriTileUrl(tier, year, row, col), signal);
        return gr ? makeLandcoverRasterLayer(gr, opacity, classIds ?? null, datasetKey) : null;
      }),
    );
  } else if (datasetKey === "grpk") {
    if (tier === "close") {
      cellLayers = await Promise.all(
        cells.map(([row, col]) => loadGrpkVectorLayer(row, col, opacity, classIds, signal)),
      );
    } else {
      cellLayers = await Promise.all(
        cells.map(async ([row, col]) => {
          const gr = await getGeorasterCachedByUrl(grpkRasterTileUrl(tier, row, col), signal);
          return gr ? makeLandcoverRasterLayer(gr, opacity, classIds ?? null, datasetKey) : null;
        }),
      );
    }
  } else {
    cellLayers = [];
  }
  const result = cellLayers.filter(Boolean);
  tiledLog(`buildTiledLayers done: ${datasetKey} tier=${tier} — ${result.length}/${cells.length} layers built`);
  return result;
}

// ── Esri: real pre-rendered XYZ tile pyramid (z4-12) ─────────────────────
// This is the technique actual Sentinel-2 viewers use for smooth zoom/pan:
// every tile is a small, already-colored PNG generated once offline (see
// analysis/export_esri_xyz_tiles.py) — the browser just requests whichever
// plain image is in view via a standard Leaflet tile layer. No per-tile
// GeoTIFF decode/reprojection/classification happens client-side at all,
// which is what made the georaster-layer-for-leaflet chunk system slow
// even after several rounds of fixing its race conditions. Beyond z12 the
// tile count explodes into the hundreds of thousands per year, so the
// existing chunk-based "close" tier (still georaster-layer-for-leaflet,
// already fixed) takes over there instead of trying to pre-render that far.
const ESRI_XYZ_MAX_ZOOM = 12;

// Bump this whenever the exported tiles under rasters/esri/xyz or
// rasters/grpk/xyz are regenerated. Plain http.server sends no Cache-Control
// header on these PNGs, so Chrome can heuristically cache them (based on
// Last-Modified alone) well beyond a simple reload — a user who loaded the
// map before a re-export could keep seeing stale, already-fixed-on-disk
// tiles indefinitely otherwise. Changing this query param gives every tile
// URL a new identity, guaranteeing a fresh fetch instead of a cache hit.
const XYZ_TILE_ASSET_VERSION = 5;

const ESRI_XYZ_CLASS_COLORS = {
  1: [0x4d, 0xa6, 0xff], // Water
  2: [0x7b, 0x68, 0xee], // Wetland
  3: [0xff, 0x4d, 0x4d], // Urban
  4: [0xff, 0xd2, 0x4d], // Agriculture
  5: [0x22, 0x8b, 0x22], // Forest
};

// Shared tile-loading implementation for EsriXyzLayer/GrpkXyzLayer (real
// pre-rendered XYZ raster tile pyramids). This used to load tiles via plain
// `new Image(); img.src = url`, but that gives no visibility into WHY a
// load failed — the `error` event fires identically for a genuine 404 (tile
// legitimately has no data outside the country) and for a transient
// connection failure. Confirmed via a stress test (rapid, chaotic zooming)
// that Python's http.server — a development server with a tiny connection
// backlog, never meant for hundreds of near-simultaneous requests — starts
// resetting connections under that load (matching the ConnectionResetError
// tracebacks seen server-side); the client saw this as a wave of ordinary
// image "error" events indistinguishable from real 404s. Since every error
// was treated as "permanently no data," a tile caught by a transient
// overload stayed blank forever even though the file existed and a moment
// later the server would have served it fine — this is what caused the map
// to sometimes end up mostly blank after fast zooming and never recover.
// Using fetch() instead exposes the real HTTP status, so a genuine 404 is
// distinguished from everything else (which gets retried with backoff).
const XYZ_TILE_MAX_RETRIES = 3;
const XYZ_TILE_RETRY_DELAY_MS = 200;
const xyzKnownMissing = new Set(); // URLs confirmed 404 — never worth retrying

async function fetchXyzTileBitmap(url, signal) {
  if (xyzKnownMissing.has(url)) return null;
  let lastErr = null;
  for (let attempt = 0; attempt <= XYZ_TILE_MAX_RETRIES; attempt++) {
    if (signal.aborted) return null;
    try {
      const resp = await fetch(url, { signal });
      if (resp.status === 404) {
        xyzKnownMissing.add(url);
        return null; // outside actual data coverage — not an error, never retry
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      return await createImageBitmap(blob);
    } catch (e) {
      if (e.name === "AbortError") return null; // superseded — not a failure
      lastErr = e;
      if (attempt < XYZ_TILE_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, XYZ_TILE_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  console.warn("[XYZ tile] gave up after retries:", url, lastErr);
  return null;
}

/** Shared createTile body: fetches (with retry) the same plain PNG tile a
 * normal Leaflet tile layer would, but draws it via canvas so deselected
 * classes can be made transparent — a cheap per-tile pixel pass against the
 * fixed 5-color palette, not a full reprojection/decode, so class filtering
 * stays fast even though tiles are pre-rendered images. */
function createXyzTile(layer, coords, done, getUrl) {
  const size = layer.getTileSize();
  const canvas = document.createElement("canvas");
  canvas.width = size.x;
  canvas.height = size.y;
  const ctx = canvas.getContext("2d");
  const url = getUrl(coords);

  const draw = (bitmap) => {
    if (canvas._aborted) return; // superseded before the fetch/decode finished
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const classIds = layer.options.selectedClassIds; // null/undefined = show all
      if (classIds) {
        try {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;
          const hiddenColors = Object.entries(ESRI_XYZ_CLASS_COLORS)
            .filter(([cid]) => !classIds.includes(Number(cid)))
            .map(([, rgb]) => rgb);
          if (hiddenColors.length) {
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] === 0) continue; // already transparent (nodata)
              for (const [cr, cg, cb] of hiddenColors) {
                if (data[i] === cr && data[i + 1] === cg && data[i + 2] === cb) {
                  data[i + 3] = 0;
                  break;
                }
              }
            }
            ctx.putImageData(imgData, 0, 0);
          }
        } catch (e) {
          console.error("[XyzLayer] recolor failed:", e);
        }
      }
    }
    done(null, canvas);
  };

  const cached = layer._decodedImgCache.get(url);
  if (cached) {
    // Leaflet's own GridLayer._addTile calls createTile(coords, done) and
    // only registers this._tiles[key] *after* createTile returns; _tileReady
    // (== done) bails out silently (`if (!tile) return`) if that entry
    // doesn't exist yet. Calling done() synchronously from inside createTile
    // fires _tileReady before _addTile has registered the tile, so it
    // silently never gets marked loaded/active, and Leaflet's own pruning
    // can then strip it from the DOM later even while still in view.
    // Deferring to a microtask guarantees createTile has already returned.
    queueMicrotask(() => draw(cached));
    return canvas;
  }

  const controller = new AbortController();
  canvas._abortController = controller;
  fetchXyzTileBitmap(url, controller.signal).then((bitmap) => {
    if (bitmap) layer._decodedImgCache.set(url, bitmap);
    draw(bitmap);
  });
  return canvas;
}

/** Shared _abortLoading: L.GridLayer (which both EsriXyzLayer and
 * GrpkXyzLayer extend) has no _abortLoading of its own — only L.TileLayer
 * does, to cancel in-flight tile loads for a now-stale zoom level. Confirmed
 * by reading Leaflet's source: _setView only calls `this._abortLoading()`
 * if that method exists at all, so these tiles were silently exempt —
 * every in-flight request from every zoom level visited during a rapid
 * zoom burst kept running, all competing for the same limited pool of
 * connections instead of yielding to whatever the current view actually
 * needs. */
function abortXyzTileLoading(layer) {
  for (const key in layer._tiles) {
    const tile = layer._tiles[key];
    if (tile.coords.z !== layer._tileZoom && !tile.loaded) {
      if (tile.el._abortController) tile.el._abortController.abort();
      tile.el._aborted = true;
      if (tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
      delete layer._tiles[key];
    }
  }
}

/** Custom GridLayer: fetches the same plain PNG tile that a normal
 * Leaflet tile layer would, but draws it via canvas so deselected classes
 * can be made transparent — a cheap per-tile pixel pass (reverse-matching
 * against the fixed 5-color palette), not a full reprojection/decode, so
 * class filtering stays fast even though tiles are pre-rendered images. */
const EsriXyzLayer = L.GridLayer.extend({
  initialize: function (options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this._decodedImgCache = new Map(); // url -> decoded ImageBitmap (pre-recolor)
  },

  getEsriTileUrl: function (coords) {
    return resolveDataFileUrl(`rasters/esri/xyz/${this.options.year}/${coords.z}/${coords.x}/${coords.y}.png?v=${XYZ_TILE_ASSET_VERSION}`);
  },

  createTile: function (coords, done) {
    return createXyzTile(this, coords, done, (c) => this.getEsriTileUrl(c));
  },

  _abortLoading: function () {
    abortXyzTileLoading(this);
  },
});

/** Creates (or updates in place) the persistent Esri XYZ layer for the
 * current year/opacity/class-filter — reused across pans/zooms within the
 * z4-12 range instead of being recreated, so toggling the class filter or
 * changing years redraws already-cached tile images instead of re-fetching. */
function ensureEsriXyzLayer(map, year, opacity, classIds) {
  const selectedClassIds = classIds && classIds.length ? classIds : null;
  let layer = state.map.esriXyzLayer;
  if (!layer) {
    layer = new EsriXyzLayer({
      pane: "rasterPane",
      tileSize: 256,
      minZoom: 0,
      // maxZoom stays well above maxNativeZoom: past z12 Leaflet just CSS-
      // upscales the deepest tiles we actually generated instead of trying
      // to fetch tiles that don't exist. This is the standard tile-pyramid
      // behavior (matches how real satellite basemaps handle over-zooming)
      // and replaces the old fallback to the chunk-based georaster "close"
      // tier, which was the actual source of the "reloads into pixelated
      // blocks and lags" report — that fallback is gone now, Esri stays on
      // this XYZ layer at every zoom level.
      maxZoom: 19,
      minNativeZoom: 4,
      maxNativeZoom: ESRI_XYZ_MAX_ZOOM,
      opacity: opacity !== undefined ? opacity : 0.65,
      year,
      selectedClassIds,
    });
    layer.addTo(map);
    setRasterLayerVisible(map, layer, state.map.opts.showRaster);
    state.map.esriXyzLayer = layer;
    tiledLog(`created EsriXyzLayer: year=${year} classIds=${selectedClassIds}`);
    return;
  }
  const yearChanged = layer.options.year !== year;
  const opacityVal = opacity !== undefined ? opacity : 0.65;
  if (layer.options.opacity !== opacityVal) layer.setOpacity(opacityVal);
  const classIdsKeyOld = layer.options.selectedClassIds ? layer.options.selectedClassIds.slice().sort().join(",") : "all";
  const classIdsKeyNew = selectedClassIds ? selectedClassIds.slice().sort().join(",") : "all";
  if (yearChanged || classIdsKeyOld !== classIdsKeyNew) {
    layer.options.year = year;
    layer.options.selectedClassIds = selectedClassIds;
    layer.redraw();
    tiledLog(`updated EsriXyzLayer in place: year=${year} classIds=${selectedClassIds} (redraw)`);
  }
}

function removeEsriXyzLayer(map) {
  if (state.map.esriXyzLayer) {
    map.removeLayer(state.map.esriXyzLayer);
    state.map.esriXyzLayer = null;
    tiledLog("removed EsriXyzLayer");
  }
}

// ── GRPK: real pre-rendered XYZ tile pyramid for national/regional ──────
// Same technique as Esri above (see analysis/export_grpk_xyz_tiles.py),
// reprojected offline from the already-computed national.tif/regional
// chunks rather than the raw ~1.95M-parcel source, so it stays cheap. GRPK
// has no year dimension (one cadastre snapshot). z12+ still uses the real
// vector polygon tier below (lossless, unaffected by this).
const GRPK_XYZ_MAX_ZOOM = 11;

const GrpkXyzLayer = L.GridLayer.extend({
  initialize: function (options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this._decodedImgCache = new Map();
  },

  getGrpkTileUrl: function (coords) {
    return resolveDataFileUrl(`rasters/grpk/xyz/${coords.z}/${coords.x}/${coords.y}.png?v=${XYZ_TILE_ASSET_VERSION}`);
  },

  createTile: function (coords, done) {
    return createXyzTile(this, coords, done, (c) => this.getGrpkTileUrl(c));
  },

  _abortLoading: function () {
    abortXyzTileLoading(this);
  },
});

function ensureGrpkXyzLayer(map, opacity, classIds) {
  const selectedClassIds = classIds && classIds.length ? classIds : null;
  let layer = state.map.grpkXyzLayer;
  if (!layer) {
    layer = new GrpkXyzLayer({
      pane: "rasterPane",
      tileSize: 256,
      minZoom: 0,
      maxZoom: TIER_ZOOM_THRESHOLDS.close, // vector tier takes over from here
      minNativeZoom: 4,
      maxNativeZoom: GRPK_XYZ_MAX_ZOOM,
      opacity: opacity !== undefined ? opacity : 0.65,
      selectedClassIds,
    });
    layer.addTo(map);
    setRasterLayerVisible(map, layer, state.map.opts.showRaster);
    state.map.grpkXyzLayer = layer;
    tiledLog(`created GrpkXyzLayer: classIds=${selectedClassIds}`);
    return;
  }
  const opacityVal = opacity !== undefined ? opacity : 0.65;
  if (layer.options.opacity !== opacityVal) layer.setOpacity(opacityVal);
  const classIdsKeyOld = layer.options.selectedClassIds ? layer.options.selectedClassIds.slice().sort().join(",") : "all";
  const classIdsKeyNew = selectedClassIds ? selectedClassIds.slice().sort().join(",") : "all";
  if (classIdsKeyOld !== classIdsKeyNew) {
    layer.options.selectedClassIds = selectedClassIds;
    layer.redraw();
    tiledLog(`updated GrpkXyzLayer in place: classIds=${selectedClassIds} (redraw)`);
  }
}

function removeGrpkXyzLayer(map) {
  if (state.map.grpkXyzLayer) {
    map.removeLayer(state.map.grpkXyzLayer);
    state.map.grpkXyzLayer = null;
    tiledLog("removed GrpkXyzLayer");
  }
}

/** Tiled-dataset counterpart of updateRasterOverlay(): picks the zoom tier
 * and viewport cell(s) for esri/grpk instead of loading one whole-country
 * file, and skips the reload entirely if nothing relevant has changed. */
async function updateTiledRasterOverlay(datasetKey, year, classIds, seqAtCall) {
  tiledLog(`updateTiledRasterOverlay called: dataset=${datasetKey} year=${year} seq=${seqAtCall} (current seq=${applyFiltersSeq})`);
  const map = state.map.instance;
  if (!map) return;
  const hint = document.getElementById("map-overlay-hint");

  // Cancel whatever the previous call was still fetching — it's about to be
  // superseded anyway, so let its network requests go instead of leaving
  // them to finish pointlessly in the background.
  if (tiledFetchController) tiledFetchController.abort();
  const controller = new AbortController();
  tiledFetchController = controller;

  if (!Number.isFinite(year) && datasetKey !== "grpk") {
    tiledLog("bail: non-finite year for non-grpk dataset");
    removeTiledLayerGroup(map);
    state.map.tiledActive = null;
    if (hint) hint.textContent = "No raster for the resolved map year.";
    return;
  }

  // Esri: always use the pre-rendered XYZ pyramid — no manifest/cell
  // computation needed at all, Leaflet's own tile layer handles panning/
  // zooming natively. Past maxNativeZoom it just upscales the deepest
  // generated tiles (see ensureEsriXyzLayer) instead of falling back to the
  // old chunk-based georaster "close" tier, which is what was actually
  // causing the "reloads into pixelated blocks and lags" report at deep
  // zoom — that fallback path is now unreachable for esri.
  if (datasetKey === "esri") {
    if (state.map.tiledLayerGroup) {
      tiledLog("switching Esri from close-tier chunks to the XYZ pyramid — removing chunk layer");
      removeTiledLayerGroup(map);
    }
    const opacitySlider = document.getElementById("opacity-slider");
    const opacity = opacitySlider ? Number(opacitySlider.value) : 0.65;
    ensureEsriXyzLayer(map, year, opacity, classIds);
    state.map.tiledActive = {
      datasetKey,
      year,
      tier: "xyz",
      cellsKey: "xyz",
      classIdsKey: classIds && classIds.length ? classIds.slice().sort((a, b) => a - b).join(",") : "all",
    };
    if (hint) hint.textContent = "";
    return;
  }

  // GRPK below the close/vector threshold: same pre-rendered XYZ pyramid
  // technique as Esri (see ensureGrpkXyzLayer), replacing the chunk-based
  // georaster national/regional tiers — those rendered at a deliberately
  // low internal sample resolution (a earlier perf tradeoff) which is what
  // made GRPK look pixelated/blocky except right at the close/vector tier.
  if (datasetKey === "grpk" && map.getZoom() < TIER_ZOOM_THRESHOLDS.close) {
    if (state.map.tiledLayerGroup) {
      tiledLog("switching GRPK from vector chunks to the XYZ pyramid — removing vector layer");
      removeTiledLayerGroup(map);
    }
    const opacitySlider = document.getElementById("opacity-slider");
    const opacity = opacitySlider ? Number(opacitySlider.value) : 0.65;
    ensureGrpkXyzLayer(map, opacity, classIds);
    state.map.tiledActive = {
      datasetKey,
      year: 0,
      tier: "xyz",
      cellsKey: "xyz",
      classIdsKey: classIds && classIds.length ? classIds.slice().sort((a, b) => a - b).join(",") : "all",
    };
    if (hint) hint.textContent = "";
    return;
  }
  if (datasetKey === "grpk") {
    // At/above the close threshold: drop the XYZ layer, fall through to the
    // real vector polygon tier below (lossless, already correct).
    removeGrpkXyzLayer(map);
  }

  const manifest = await getTileManifest(datasetKey);
  if (seqAtCall !== applyFiltersSeq) { tiledLog(`stale after manifest fetch (seq ${seqAtCall} vs ${applyFiltersSeq}) — bailing`); return; }
  if (!manifest) {
    tiledLog("bail: no manifest for", datasetKey);
    if (hint) hint.textContent = "Tile manifest not found.";
    return;
  }

  // GRPK's tiles don't depend on year at all (single cadastre snapshot) —
  // normalize to a fixed value so the "did anything change" comparison below
  // never spuriously reloads due to comparing NaN/undefined to itself.
  const yearForCompare = datasetKey === "grpk" ? 0 : year;

  const zoom = map.getZoom();
  const tier = pickTierForZoom(zoom);
  // Small pad so cells just outside the visible area are already loaded —
  // panning a short distance then finds its cells already present instead
  // of hitting a blank gap while a fresh fetch runs. Kept deliberately small
  // (not e.g. 0.5): every extra cell in view means another independent
  // GeoRasterLayer that has to do its own expensive tile setup the moment
  // it's added — padding too generously was multiplying how many of those
  // had to be created at once, which is what was making addTo(map) itself
  // take seconds during rapid zoom (letting the real zoom level move on
  // before the stale add even finished).
  const bounds = map.getBounds().pad(0.15);

  let grid;
  let populatedCells;
  if (datasetKey === "esri") {
    const tierCfg = manifest.tiers[tier];
    grid = tierCfg.grid;
    populatedCells = tierCfg.years?.[String(year)];
  } else if (tier === "close") {
    grid = manifest.vector_tier.grid;
    populatedCells = manifest.vector_tier.cells;
  } else {
    const tierCfg = manifest.raster_tiers[tier];
    grid = tierCfg.grid;
    populatedCells = tierCfg.cells;
  }

  const cells = cellsForBounds(manifest.bbox, grid, bounds, populatedCells);
  const cellsKey = cellsKeyFor(cells);
  const opacitySlider = document.getElementById("opacity-slider");
  const opacity = opacitySlider ? Number(opacitySlider.value) : 0.65;
  const classIdsKey = classIds && classIds.length ? classIds.slice().sort((a, b) => a - b).join(",") : "all";

  tiledLog(
    `computed: zoom=${zoom} tier=${tier} grid=${grid} cells=${cells.length} cellsKey="${cellsKey}" ` +
      `(populatedCells=${Array.isArray(populatedCells) ? populatedCells.length : populatedCells})`,
  );

  if (!cells.length) {
    tiledLog("bail: zero cells intersect the (padded) viewport — clearing layer");
    removeTiledLayerGroup(map);
    state.map.tiledActive = null;
    if (hint) hint.textContent = `No ${datasetKey.toUpperCase()} tiles for this view.`;
    return;
  }

  const active = state.map.tiledActive;
  if (
    active &&
    active.datasetKey === datasetKey &&
    active.year === yearForCompare &&
    active.tier === tier &&
    active.cellsKey === cellsKey &&
    active.classIdsKey === classIdsKey &&
    state.map.tiledLayerGroup // zoomstart may have already removed the actual
    // layer (see setupTiledOverlayZoomHandling) even though this metadata is
    // still "current" — in that case fall through and rebuild instead of
    // skipping, or the map would stay blank until something else changes.
  ) {
    tiledLog("skip: viewport/tier/filters unchanged from active state", active);
    return; // viewport/tier/filters haven't actually changed — skip the reload
  }

  // A TIER change (e.g. regional -> close) means the old layer is now wildly
  // mismatched with the current zoom — georaster-layer-for-leaflet keeps
  // trying to regenerate tiles for it as the zoom keeps changing, and each
  // tile can take 100-300ms+, saturating the main thread during a rapid
  // zoom burst (this is what was actually behind "flashes then disappears":
  // the stale layer's own runaway re-tiling starved everything else,
  // including this debounced handler, of CPU time). Removing it immediately
  // — rather than waiting for the new tier's fetch — stops that runaway
  // work right away. A same-tier cell/pan change doesn't have this problem
  // (resolution stays appropriate), so it keeps the smoother add-then-remove
  // swap instead of a hard cut.
  const tierOrDatasetChanged = !active || active.datasetKey !== datasetKey || active.tier !== tier;
  if (tierOrDatasetChanged && state.map.tiledLayerGroup) {
    tiledLog(`tier/dataset changed (${active?.tier ?? "none"} -> ${tier}) — removing stale layer immediately`);
    removeTiledLayerGroup(map);
  }

  setMapLoading(true);
  try {
    const newLayers = await buildTiledLayers(datasetKey, year, classIds, tier, cells, opacity, controller.signal);
    if (seqAtCall !== applyFiltersSeq) { tiledLog(`stale after buildTiledLayers (seq ${seqAtCall} vs ${applyFiltersSeq}) — discarding, NOT touching map`); return; }

    if (!newLayers.length) {
      // Leave whatever's still on the map (if anything) in place — a
      // stale-but-present layer is better than a blank gap for a genuinely
      // empty fetch result. Only stop treating it as "up to date".
      tiledLog("bail: buildTiledLayers returned 0 layers — leaving existing layer group untouched");
      state.map.tiledActive = null;
      if (hint) hint.textContent = `No ${datasetKey.toUpperCase()} tiles for this view.`;
      return;
    }

    // Adding a GeoRasterLayer triggers real, sometimes-slow synchronous work
    // (kicking off its internal tile generation) — adding several at once in
    // one L.layerGroup(...).addTo(map) call can block the event loop long
    // enough that a whole burst of the user's further zoom input queues up
    // unprocessed, then all lands at once right after, so the layer we just
    // finished committing is already several zoom levels stale (this is
    // what was actually behind the persistent blank-map reports). Adding one
    // at a time with a yield in between lets any queued zoom input actually
    // get processed between additions, so staleness can be caught and
    // aborted early instead of committing a doomed multi-cell layer.
    const oldGroup = state.map.tiledLayerGroup;
    const group = L.layerGroup([]);
    let addedCount = 0;
    let wentStale = false;
    for (const layer of newLayers) {
      if (seqAtCall !== applyFiltersSeq || map.getZoom() !== zoom) {
        tiledLog(
          `zoom/seq moved on mid-add (zoom was ${zoom}, now ${map.getZoom()}) — stopping after ${addedCount}/${newLayers.length} layers`,
        );
        wentStale = true;
        break;
      }
      layer.addTo(map);
      group.addLayer(layer);
      addedCount += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    // Re-check even after the loop finished ALL its layers normally: another
    // debounced call can start and run to full completion (including its
    // own commit) while this one was mid-loop, yielding between additions.
    // Without this, two overlapping calls can each finish believing they're
    // the winner — the older one then overwrites tiledLayerGroup with its
    // own (stale) result and removes the NEWER call's oldGroup snapshot
    // instead of its own, permanently orphaning the newer call's layers
    // (this was the remaining "2-4 leftover layers" case after the
    // mid-loop-only check was fixed).
    if (!wentStale && seqAtCall !== applyFiltersSeq) {
      tiledLog(`stale after full add completed (seq ${seqAtCall} vs ${applyFiltersSeq}) — discarding this result too`);
      wentStale = true;
    }

    // GRPK specifically can also have switched to the XYZ raster layer
    // (ensureGrpkXyzLayer, a synchronous branch taken by a DIFFERENT call)
    // while THIS close-tier call was mid-loop — that branch doesn't touch
    // seqAtCall/zoom, so the checks above can both still pass even though
    // "close" is no longer the right tier for grpk right now. Re-derive the
    // tier fresh from the current zoom as a final authoritative check
    // before committing vector layers on top of the XYZ layer.
    if (!wentStale && datasetKey === "grpk" && pickTierForZoom(map.getZoom()) !== "close") {
      tiledLog(`grpk switched to XYZ mode while this close-tier call was mid-add — discarding`);
      wentStale = true;
    }

    if (wentStale) {
      // Don't leave a partial/already-superseded layer group installed as
      // "the current state" — tear down only what THIS call itself added.
      // Route the "please check again" request through the SHARED debounce
      // (scheduleTiledRecheck) rather than recursing directly: several
      // overlapping stale calls each recursing on their own would keep
      // re-triggering each other forever (see scheduleTiledRecheck's own
      // comment) — coalescing into one shared timer is what actually
      // converges once the zoom stops changing.
      group.eachLayer((l) => map.removeLayer(l));
      tiledLog("discarding this stale result and scheduling one coalesced recheck");
      scheduleTiledRecheck(0);
      return;
    }

    state.map.tiledLayerGroup = group;
    state.map.tiledActive = { datasetKey, year: yearForCompare, tier, cellsKey, classIdsKey };
    // oldGroup's individual layers were each added to the map directly (see
    // the incremental-add loop above) — removing the group object itself is
    // a no-op (it was never itself registered with the map), so its
    // children must be removed one at a time instead, or they never
    // actually leave the map (this was the "leftover patch" bug).
    if (oldGroup) oldGroup.eachLayer((l) => map.removeLayer(l));
    tiledLog(`swapped in ${addedCount} layer(s) for tier=${tier} cellsKey="${cellsKey}"; old group removed=${!!oldGroup}`);

    newLayers.forEach((layer) => {
      const el = layer.getContainer?.();
      if (el) el.style.pointerEvents = "none";
      // Vector (GRPK close-tier GeoJSON) chunks have no container to hide via
      // CSS -- setRasterLayerVisible falls back to adding/removing them from
      // the map instead, which previously never happened for these at all.
      setRasterLayerVisible(map, layer, state.map.opts.showRaster);
    });

    if (state.map.basinLayer && typeof state.map.basinLayer.bringToFront === "function") {
      state.map.basinLayer.bringToFront();
    }
    if (hint) hint.textContent = "";
  } catch (e) {
    if (e.name === "AbortError") {
      tiledLog("call aborted (superseded) — not an error, no hint shown");
    } else {
      console.error(`[Tiled] load failed for ${datasetKey} ${year}:`, e);
      if (hint) hint.textContent = `Tile load failed for ${year}.`;
    }
  } finally {
    setMapLoading(false);
  }
}

/** Re-checks the tiled overlay on pan/zoom — the tier and/or which grid
 * cells are in view can change without any dataset/year/filter change. */
function setupTiledOverlayZoomHandling() {
  const map = state.map.instance;
  if (!map) return;

  // The instant ANY zoom gesture starts, drop the current tiled layer
  // immediately — not just when we later detect the tier changed. Leaving a
  // GeoRasterLayer on the map WHILE the zoom is actively changing gives
  // georaster-layer-for-leaflet a chance to start regenerating its own
  // internal tiles for the in-between zoom levels, and each tile can take
  // 100-500ms+; a burst of these during a fast zoom saturates the main
  // thread badly enough to blank the map for seconds (confirmed via
  // window.TILED_DEBUG logging). Removing on zoomstart guarantees that
  // never has a chance to begin, at the cost of a brief guaranteed blank
  // moment during every zoom instead of an occasional unbounded one.
  map.on("zoomstart", () => {
    if (state.map.tiledLayerGroup && state.map.tiledActive && TILED_DATASETS.has(state.map.tiledActive.datasetKey)) {
      tiledLog("zoomstart: dropping current tiled layer immediately to prevent runaway re-tiling");
      removeTiledLayerGroup(map);
    }
  });

  map.on("zoomend moveend", (e) => {
    tiledLog(`zoom/pan event: ${e.type} at zoom=${map.getZoom()} — (re)scheduling debounce`);
    scheduleTiledRecheck(200);
  });
}

// seqAtCall: the applyFiltersSeq value at the time this call was initiated.
// We keep the OLD layer visible while fetching so there's no blank flash.
// Only after the fetch succeeds AND no newer switch has arrived do we swap layers.
async function updateRasterOverlay(datasetKey, year, classIds, seqAtCall) {
  const map = state.map.instance;
  if (!map) return;

  if (TILED_DATASETS.has(datasetKey)) {
    // Switching INTO a tiled dataset — clear any flat-layer leftover.
    if (state.map.overlay) { map.removeLayer(state.map.overlay); state.map.overlay = null; }
    return updateTiledRasterOverlay(datasetKey, year, classIds, seqAtCall);
  }
  // Switching OUT of a tiled dataset — clear any tiled-layer leftover.
  if (state.map.tiledLayerGroup) {
    removeTiledLayerGroup(map);
    state.map.tiledActive = null;
  }
  removeEsriXyzLayer(map);
  removeGrpkXyzLayer(map);

  const hint = document.getElementById("map-overlay-hint");

  if (!Number.isFinite(year)) {
    if (state.map.overlay) { map.removeLayer(state.map.overlay); state.map.overlay = null; }
    if (hint) hint.textContent = "No raster for the resolved map year.";
    return;
  }

  if (typeof parseGeoraster === "undefined" || typeof GeoRasterLayer === "undefined") {
    if (hint) hint.textContent = "GeoTIFF libraries not loaded.";
    return;
  }

  const tifUrl = getGeotiffUrl(datasetKey, year);
  if (!tifUrl) {
    if (state.map.overlay) { map.removeLayer(state.map.overlay); state.map.overlay = null; }
    if (hint) hint.textContent = "No GeoTIFF path for dataset.";
    return;
  }

  // Remove old layer NOW so there is no coexistence window where both layers
  // have tiles in the DOM simultaneously — that is what causes the patchwork.
  if (state.map.overlay) {
    map.removeLayer(state.map.overlay);
    state.map.overlay = null;
  }

  setMapLoading(true);
  try {
    const georaster = await getGeorasterCached(datasetKey, year);

    // Discard if a newer dataset switch arrived while we were fetching.
    if (seqAtCall !== applyFiltersSeq) return;

    if (!georaster) {
      if (hint) hint.textContent = `No GeoTIFF for ${year}.`;
      return;
    }

    const opacitySlider = document.getElementById("opacity-slider");
    const opacity = opacitySlider ? Number(opacitySlider.value) : 0.65;

    const _renderStart = performance.now();
    const layerMain = makeLandcoverRasterLayer(georaster, opacity, classIds ?? null, datasetKey);
    layerMain.addTo(map);
    state.map.overlay = layerMain;
    console.log(`[Raster] ✓ ${datasetKey} ${year} — layer created in ${(performance.now() - _renderStart).toFixed(1)} ms`);

    const mainEl = layerMain.getContainer?.();
    if (mainEl) {
      mainEl.style.pointerEvents = "none";
      if (!state.map.opts.showRaster) mainEl.style.display = "none";
    }

    if (state.map.basinLayer && typeof state.map.basinLayer.bringToFront === "function") {
      state.map.basinLayer.bringToFront();
    }

    if (hint) hint.textContent = "";
  } catch (e) {
    console.error(`[Raster] load failed for ${datasetKey} ${year}:`, e);
    if (hint) hint.textContent = `GeoTIFF load failed for ${year}.`;
  } finally {
    setMapLoading(false);
  }
}

async function scanRasterYears(datasetKey) {
  const candidates = getYearsForMapSlider(datasetKey);
  if (candidates.length === 0) {
    state.rasterYearsByDataset[datasetKey] = [];
    return [];
  }

  const hint = document.getElementById("map-overlay-hint");
  if (hint) hint.textContent = "Scanning available rasters…";

  const geotiffPaths = {
    hildaknn: (y) => resolveDataFileUrl(`rasters/hildaknn/geotiff/hildaknn_${y}.tif`),
    lucas: (y) => resolveDataFileUrl(`rasters/lucas/geotiff/lucas_${y}.tif`),
    hyde: (y) => resolveDataFileUrl(`rasters/hyde/geotiff/hyde_${y}.tif`),
    luh2: (y) => resolveDataFileUrl(`rasters/luh2/geotiff/luh2_${y}.tif`),
    corine: (y) => resolveDataFileUrl(`rasters/corine/geotiff/corine_${y}.tif`),
    esri: (y) => resolveDataFileUrl(`rasters/esri/geotiff/esri_${y}.tif`),
    grpk: (y) => resolveDataFileUrl(`rasters/grpk/geotiff/grpk_${y}.tif`),
  };
  const tifPath = geotiffPaths[datasetKey];

  // Datasets with long year ranges (HILDA/LUCAS/HYDE/LUH2 can span 100+
  // years) used to check each year's file existence one at a time, awaited
  // sequentially in a loop — 100+ round trips end to end before the map was
  // even usable, which is what made those specific datasets take 10-20s to
  // load while the short-year datasets (Esri, CORINE, GRPK) felt instant.
  // Firing them in parallel (below) doesn't fully fix it on its own: Chrome
  // caps concurrent connections at ~6 per origin, so 100+ parallel fetch()
  // calls still queue into ~18 sequential batches — confirmed by timing the
  // actual responses, which trickled in over ~6s even though every request
  // was dispatched within the first 200ms. Past a threshold, the per-year
  // existence check just isn't worth its own round trips at all: skip it and
  // trust the CSV-listed years directly (the same fallback this function
  // already used whenever the scan came back "inconclusive") — the actual
  // raster-load path already handles a missing file gracefully with its own
  // error message, so nothing is lost by not pre-verifying at this scale.
  const SCAN_YEAR_LIMIT = 30;
  if (candidates.length > SCAN_YEAR_LIMIT) {
    state.rasterYearsByDataset[datasetKey] = candidates.slice();
    if (hint) hint.textContent = `Using ${candidates.length} CSV years (skipped per-year existence check — too many years for it to be worth the round trips).`;
    return state.rasterYearsByDataset[datasetKey];
  }

  async function checkYear(year) {
    if (!tifPath) return null;
    const url = tifPath(year);
    try {
      const r = await fetch(url, { method: "HEAD", mode: "cors" });
      if (r.ok) return year;
    } catch (_) {
      // fall through to the ranged GET below
    }
    try {
      const r2 = await fetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        headers: { Range: "bytes=0-1" },
      });
      if (r2.ok || r2.status === 206) return year;
    } catch (_) {
      // treated as not-found below
    }
    return null;
  }
  const results = await Promise.all(candidates.map(checkYear));
  const found = results.filter((y) => y !== null);

  let yearsOut = found;
  if (yearsOut.length === 0 && candidates.length) {
    yearsOut = candidates.slice();
    if (hint) {
      hint.textContent = `GeoTIFF check inconclusive (HEAD often blocked on static hosts). Using ${yearsOut.length} CSV years — map may warn if a file is missing.`;
    }
  } else if (hint) {
    hint.textContent =
      yearsOut.length > 0 ? `Found ${yearsOut.length} GeoTIFF year(s).` : "No GeoTIFF files found.";
  }
  state.rasterYearsByDataset[datasetKey] = yearsOut;
  return yearsOut;
}

function collectClasses(datasetRows) {
  if (!datasetRows) return [];
  const set = new Set(datasetRows.map((r) => r.class_name).filter(Boolean));
  return Array.from(set).sort();
}

const CANONICAL_CLASSES = ["Water", "Wetland", "Urban", "Agriculture", "Forest"];

function populateClassDropdown(datasetKey) {
  const select = document.getElementById("class-select");
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";

  // Always include the full canonical list so classes like Wetland (rare but
  // present in GeoTIFFs) are always selectable even if missing from the CSV.
  const csvClasses = new Set(collectClasses(state[datasetKey]));
  const classes = [
    ...CANONICAL_CLASSES,
    ...Array.from(csvClasses).filter((c) => !CANONICAL_CLASSES.includes(c)).sort(),
  ];

  const allOpt = document.createElement("option");
  allOpt.value = "ALL";
  allOpt.textContent = "All classes";
  select.appendChild(allOpt);

  classes.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  // Restore previous selection if still valid
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

/** Rebuilds the legend for whatever dataset/class-filter is currently
 * selected in the UI — used by anything that changes something setLegend's
 * output depends on (currently just the hydro-stations toggle) outside of
 * the normal Apply Filters / dataset-switch flow that already calls
 * setLegend directly. */
function refreshLegendForCurrentDataset() {
  const datasetKey = document.getElementById("dataset-select")?.value;
  if (datasetKey) setLegend(datasetKey, getSelectedClassNames());
}

function setLegend(datasetKey, selectedClasses) {
  const el = document.getElementById("map-legend");
  if (!el) return;

  const legends = {
    hildaknn: {
      title: "Legend (HILDA+ With KNN)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    lucas: {
      title: "Legend (LUCAS dominant)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    hyde: {
      title: "Legend (HYDE 3.4 — residual land, not forest inventory)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Natural (residual)", color: "#228B22" },
      ],
    },
    luh2: {
      title: "Legend (LUH2 v2h)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    corine: {
      title: "Legend (CORINE CLC, validation)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    esri: {
      title: "Legend (Esri 10m Annual LULC, validation)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
    grpk: {
      title: "Legend (GRPK PLOTAI, cadastre)",
      items: [
        { label: "Water", color: "#4DA6FF" },
        { label: "Wetland", color: "#7B68EE" },
        { label: "Urban", color: "#FF4D4D" },
        { label: "Agriculture", color: "#FFD24D" },
        { label: "Forest", color: "#228B22" },
      ],
    },
  };

  const cfg = legends[datasetKey] || legends.hildaknn;
  const selectedSet = selectedClasses && selectedClasses.length < CANONICAL_CLASSES.length
    ? new Set(selectedClasses.map((c) => c === "Forest" ? c : c))
    : null;

  const hydeForestLabel = "Natural (residual)";
  const visibleItems = selectedSet
    ? cfg.items.filter((it) => {
        const key = (datasetKey === "hyde" && it.label === hydeForestLabel) ? "Forest" : it.label;
        return selectedSet.has(key) || selectedSet.has(it.label);
      })
    : cfg.items;

  const itemsHtml = visibleItems
    .map(
      (it) =>
        `<div class="legend-item"><span class="legend-swatch" style="background:${it.color}"></span>${it.label}</div>`,
    )
    .join("");

  const filterNote = selectedSet ? `<div class="legend-filter-note">${visibleItems.length} of ${cfg.items.length} classes shown</div>` : "";

  // The two hydrology station-marker shapes (see hydroStationTriangleIcon)
  // only make sense in the legend while that layer is actually on the map.
  const stationItemsHtml = state.map.opts.showHydroStations
    ? `<div class="legend-item legend-item-station"><span class="legend-swatch-triangle" style="border-bottom-color:${HYDRO_MARKER_FILL_DEFAULT}"></span>Hydrological station</div>
       <div class="legend-item legend-item-station"><span class="legend-swatch-triangle" style="border-bottom-color:${HYDRO_MARKER_FILL_ANALYSIS}"></span>Reference station (used in analysis)</div>`
    : "";

  el.innerHTML = `
    <div class="legend-title">${cfg.title}</div>
    ${filterNote}
    <div class="legend-items">${itemsHtml}${stationItemsHtml}</div>
  `;
}

function setYearSliderForDataset(datasetKey) {
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");
  const csvYears = getYearsForMapSlider(datasetKey);
  if (!yearSlider || !yearLabel) return;

  if (csvYears.length === 0) {
    yearSlider.min = 0;
    yearSlider.max = 0;
    yearSlider.value = 0;
    yearLabel.textContent = "—";
    yearLabel.dataset.calendarYear = "";
    yearLabel.dataset.rasterYear = "";
    return;
  }

  let minY = csvYears[0];
  let maxY = csvYears[csvYears.length - 1];
  const { fromY, toY } = readFilterYearRange();
  if (Number.isFinite(fromY)) minY = Math.max(minY, fromY);
  if (Number.isFinite(toY)) maxY = Math.min(maxY, toY);
  if (minY > maxY) [minY, maxY] = [maxY, minY];

  yearSlider.min = String(minY);
  yearSlider.max = String(maxY);
  yearSlider.step = "1";

  let cur = Number(yearSlider.value);
  if (!Number.isFinite(cur) || cur <= 0) cur = maxY;
  cur = Math.min(maxY, Math.max(minY, cur));
  yearSlider.value = String(cur);

  const ry = pickRasterYearForCalendarYear(cur, getRasterYearsSorted(datasetKey));
  yearLabel.textContent = formatMapYearLabel(cur, ry);
  yearLabel.dataset.calendarYear = String(cur);
  yearLabel.dataset.rasterYear = Number.isFinite(ry) ? String(ry) : "";
  const yi = document.getElementById("year-input");
  if (yi) yi.value = String(cur);
}

function filterByYear(rows, fromYear, toYear) {
  if (!rows) return [];
  return rows.filter((r) => {
    if (!Number.isFinite(fromYear) && !Number.isFinite(toYear)) return true;
    if (Number.isFinite(fromYear) && r.year < fromYear) return false;
    if (Number.isFinite(toYear) && r.year > toYear) return false;
    return true;
  });
}

function buildHildaTrend(rows, selectedClasses) {
  if (!rows || rows.length === 0) return { labels: [], series: [] };

  const byYear = {};
  rows.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = {};
    byYear[r.year][r.class_name] = (byYear[r.year][r.class_name] || 0) + r.count;
  });

  const years = Object.keys(byYear).map((y) => Number(y)).sort((a, b) => a - b);
  const allClasses = collectClasses(rows);
  const classNames =
    selectedClasses && selectedClasses.length < allClasses.length
      ? allClasses.filter((c) => selectedClasses.includes(c))
      : allClasses;

  const series = classNames.map((cls) => ({
    label: cls,
    data: years.map((year) => {
      const counts = byYear[year];
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      return total > 0 ? ((counts[cls] || 0) / total) * 100.0 : 0;
    }),
  }));

  return { labels: years, series, yLabel: "% of grid cells" };
}

function buildHydeLuh2Trend(rows, selectedClasses) {
  if (!rows || rows.length === 0) return { labels: [], series: [] };
  const byYear = {};
  rows.forEach((r) => {
    if (!byYear[r.year]) byYear[r.year] = {};
    byYear[r.year][r.class_name] = (byYear[r.year][r.class_name] || 0) + r.count;
  });
  const years = Object.keys(byYear).map((y) => Number(y)).sort((a, b) => a - b);
  const allClasses = collectClasses(rows);
  const classNames =
    selectedClasses && selectedClasses.length < allClasses.length
      ? allClasses.filter((c) => selectedClasses.includes(c))
      : allClasses;
  const series = classNames.map((cls) => ({
    label: cls,
    data: years.map((year) => {
      const counts = byYear[year];
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      return total > 0 ? ((counts[cls] || 0) / total) * 100.0 : 0;
    }),
  }));
  return { labels: years, series, yLabel: "% of grid cells" };
}

function renderTrendChart(datasetKey, selectedClasses, fromYear, toYear, trendOverride) {
  const ctx = document.getElementById("trend-chart").getContext("2d");
  const useOverride =
    trendOverride &&
    Array.isArray(trendOverride.labels) &&
    trendOverride.labels.length > 0 &&
    Array.isArray(trendOverride.series);

  let labels;
  let series;
  let yLabel;

  if (useOverride) {
    labels = trendOverride.labels;
    series = trendOverride.series;
    yLabel = trendOverride.yLabel || "% of basin cells";
  } else {
    const rows = filterByYear(state[datasetKey], fromYear, toYear);
    const builder =
      datasetKey === "hyde" || datasetKey === "luh2" ? buildHydeLuh2Trend : buildHildaTrend;
    const built = builder(rows, selectedClasses);
    labels = built.labels;
    series = built.series;
    yLabel = built.yLabel;
  }

  if (state.charts.trend) state.charts.trend.destroy();

  const nYears = labels.length;
  let maxTicksLimit = 22;
  if (nYears > 80) maxTicksLimit = 10;
  else if (nYears > 45) maxTicksLimit = 14;
  else if (nYears > 24) maxTicksLimit = 18;

  const lucasColors = {
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    Water: "#4DA6FF",
    Urban: "#FF4D4D",
    Wetland: "#7B68EE",
  };
  const hydeLuh2Colors = {
    Water: "#4DA6FF",
    Wetland: "#7B68EE",
    Urban: "#FF4D4D",
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    "Natural (residual)": "#228B22",
  };

  const fallback = ["#0f766e", "#e11d48", "#0369a1", "#ca8a04", "#7c3aed"];

  state.charts.trend = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: (series || []).map((s, idx) => ({
        label: s.label,
        data: s.data,
        fill: false,
        borderColor: useOverride
          ? hydeLuh2Colors[s.label] || fallback[idx % 5]
          : datasetKey === "lucas"
            ? lucasColors[s.label] || fallback[idx % 5]
            : hydeLuh2Colors[s.label] || fallback[idx % 5],
        tension: 0.25,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 4, right: 6, bottom: 10, left: 4 },
      },
      plugins: {
        legend: { display: true },
      },
      scales: {
        x: {
          title: { display: true, text: "Year" },
          ticks: {
            autoSkip: true,
            maxTicksLimit,
            maxRotation: 45,
            minRotation: 0,
          },
          grid: { display: true },
        },
        y: { title: { display: true, text: yLabel } },
      },
    },
  });
}

// Class colors for distribution chart (match map legends)
const classColorsByDataset = {
  hildaknn: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  lucas: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  hyde: {
    Water: "#4DA6FF",
    Wetland: "#7B68EE",
    Urban: "#FF4D4D",
    Agriculture: "#FFD24D",
    Forest: "#228B22",
    "Natural (residual)": "#228B22",
  },
  luh2: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  corine: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  esri: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
  grpk: { Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D", Agriculture: "#FFD24D", Forest: "#228B22" },
};
const fallbackColors = ["#0f766e", "#2563eb", "#f97316", "#e11d48", "#7c3aed", "#64748b"];

/**
 * @param {string} datasetKey
 * @param {{ mapYear?: number, distOverride?: { labels: string[], values: number[] } }} options
 *        distOverride = sub-basin zonal for mapYear; else national CSV for mapYear.
 */
function renderDistributionChart(datasetKey, options = {}) {
  const ctx = document.getElementById("distribution-chart").getContext("2d");
  const { mapYear, distOverride, selectedClasses } = options;
  const useOverride =
    distOverride &&
    Array.isArray(distOverride.labels) &&
    distOverride.labels.length > 0 &&
    Array.isArray(distOverride.values);

  let labels;
  let values;

  if (useOverride) {
    labels = distOverride.labels;
    values = distOverride.values;
  } else if (Number.isFinite(mapYear)) {
    const built = buildNationalDistributionForYear(state[datasetKey], mapYear, datasetKey);
    labels = built.labels;
    values = built.values;
  } else {
    labels = [];
    values = [];
  }

  // Filter to only selected classes. Track how much share the deselected
  // classes represent — Chart.js always scales whatever slices it's given
  // to fill the full circle, so without correcting for this, deselecting
  // classes would stretch the remaining slices out to 100% instead of
  // leaving their true, smaller share of the whole with a gap for the rest.
  let deselectedShare = 0;
  if (selectedClasses && selectedClasses.length < CANONICAL_CLASSES.length) {
    const totalBeforeFilter = values.reduce((s, v) => s + (Number(v) || 0), 0);
    const filtered = { labels: [], values: [] };
    labels.forEach((lbl, i) => {
      const canon = lbl === "Natural (residual)" ? "Forest" : lbl;
      if (selectedClasses.includes(lbl) || selectedClasses.includes(canon)) {
        filtered.labels.push(lbl);
        filtered.values.push(values[i]);
      }
    });
    labels = filtered.labels;
    values = filtered.values;
    const totalAfterFilter = values.reduce((s, v) => s + (Number(v) || 0), 0);
    deselectedShare = Math.max(0, totalBeforeFilter - totalAfterFilter);
  }

  const nz = distributionNonZeroSlices(labels, values);
  labels = nz.labels;
  values = nz.values;

  if (state.charts.distribution) state.charts.distribution.destroy();

  const legendEl = document.getElementById("distribution-legend");
  if (!labels.length && deselectedShare <= 0.05) {
    if (legendEl) legendEl.innerHTML = "<span class='legend-item'>No data for this view</span>";
    return;
  }

  const colorMap = classColorsByDataset[datasetKey] || classColorsByDataset.hildaknn;
  const backgroundColor = labels.map(
    (lbl, i) => colorMap[lbl] || fallbackColors[i % fallbackColors.length],
  );

  if (legendEl) {
    const items = labels.map(
      (lbl, i) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${backgroundColor[i]}"></span>${lbl}: ${values[i].toFixed(1)}%</span>`
    );
    legendEl.innerHTML = items.join("");
  }

  // Append a transparent "remainder" slice for the deselected classes' combined
  // share — it occupies its proportional angle so the real slices stay sized
  // relative to the whole, but renders as an invisible gap, not in the legend
  // or tooltip.
  const chartLabels = labels.slice();
  const chartValues = values.slice();
  const chartBg = backgroundColor.slice();
  const chartBorder = labels.map(() => "#fff");
  const REMAINDER_LABEL = "__deselected_remainder__";
  if (deselectedShare > 0.05) {
    chartLabels.push(REMAINDER_LABEL);
    chartValues.push(deselectedShare);
    chartBg.push("rgba(0,0,0,0)");
    chartBorder.push("rgba(0,0,0,0)");
  }

  state.charts.distribution = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: chartLabels,
      datasets: [{ data: chartValues, backgroundColor: chartBg, borderColor: chartBorder, borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.label !== REMAINDER_LABEL,
        },
      },
    },
  });
}

/**
 * Quick summary under the map. When a polygon is selected, `zonalYear` must match zonal CSV keys
 * (usually the raster year used on the map).
 */
function updateBasinKeyMetrics(datasetKey, basinIndices, zonalYear, calendarYear) {
  const wrap = document.getElementById("basin-key-metrics");
  const titleEl = document.getElementById("basin-metrics-title");
  const grid = document.getElementById("basin-metrics-grid");
  if (!wrap || !grid) return;
  wrap.hidden = false;

  if (!basinIndices || !basinIndices.length) {
    if (titleEl) titleEl.textContent = "Sub-basin summary";
    grid.innerHTML =
      '<p class="basin-metrics-placeholder">Select a <strong>sub-basin</strong> in the Filters panel to see metrics here.</p>';
    return;
  }

  const names = basinIndices.map((i) => {
    const cb = document.querySelector(`.basin-cb[value="${i}"]`);
    return cb?.dataset?.basinName || `Basin ${i + 1}`;
  });
  const title = names.length === 1 ? names[0] : `${names.length} basins combined`;
  const sub = Number.isFinite(calendarYear) && Number.isFinite(zonalYear) && calendarYear !== zonalYear
    ? ` (${calendarYear} → raster ${zonalYear})`
    : Number.isFinite(zonalYear) ? ` (${zonalYear})` : "";
  if (titleEl) titleEl.textContent = `${title}${sub}`;

  const index = state.subbasinZonal[datasetKey];
  if (!(index instanceof Map) || !Number.isFinite(zonalYear)) {
    grid.innerHTML = '<p class="basin-metrics-placeholder">Load zonal statistics and choose a map year on the slider.</p>';
    return;
  }

  const labels = nationalDistributionClassLabels(datasetKey);
  let totalCells = 0;
  const aggCounts = {};
  basinIndices.forEach((bi) => {
    const cell = index.get(`${bi}|${zonalYear}`);
    if (cell && cell.total > 0) {
      totalCells += cell.total;
      for (let id = 1; id <= 5; id++) aggCounts[id] = (aggCounts[id] || 0) + (cell.counts[id] || 0);
    }
  });

  if (totalCells <= 0) {
    grid.innerHTML = '<p class="basin-metrics-placeholder">No classified cells for this selection and raster year.</p>';
    return;
  }

  const shares = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, p: ((aggCounts[i + 1] || 0) / totalCells) * 100 }));
  shares.sort((a, b) => b.p - a.p);
  const dominant = labels[(shares[0]?.id || 1) - 1] || "—";
  const secondLine = shares[1] && shares[1].p > 0.05 ? `${labels[shares[1].id - 1]} (${shares[1].p.toFixed(1)}%)` : "—";

  const tiles = [
    `<div class="metric-tile"><span class="metric-k">Classified cells</span><span class="metric-v">${totalCells.toLocaleString()}</span></div>`,
    `<div class="metric-tile"><span class="metric-k">Dominant class</span><span class="metric-v">${dominant} (${shares[0].p.toFixed(1)}%)</span></div>`,
    `<div class="metric-tile"><span class="metric-k">Second-largest class</span><span class="metric-v">${secondLine}</span></div>`,
    `<div class="metric-tile metric-tile-wide"><span class="metric-k">Note</span><span class="metric-v metric-small">Combined share of raster cells across all selected basins (Python zonal stats).</span></div>`,
  ];
  grid.innerHTML = `<div class="basin-metrics-grid-inner">${tiles.join("")}</div>`;
}

/** Update donut from current slider year (national or sub-basin) without reloading the GeoTIFF. */
function syncDistributionToMapYear() {
  const datasetSelect = document.getElementById("dataset-select");
  if (!datasetSelect) return;
  const datasetKey = datasetSelect.value;
  const { calendarYear, rasterYear } = readYearSliderMapPair(datasetKey);
  const basinVal = document.getElementById("basin-select")?.value;
  const basinIndex = basinVal === "" || basinVal === undefined ? NaN : parseInt(basinVal, 10);

  const dataYearNational = pickDataYearForCalendarYear(calendarYear, datasetKey);

  if (!Number.isFinite(basinIndex)) {
    renderDistributionChart(datasetKey, { mapYear: dataYearNational });
    updateBasinKeyMetrics(datasetKey, NaN, NaN, calendarYear);
    return;
  }
  const index = state.subbasinZonal[datasetKey];
  if (index instanceof Map) {
    const zonalYear = pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey);
    const distPayload = buildSubbasinDistPayload(index, basinIndex, zonalYear, datasetKey);
    renderDistributionChart(datasetKey, { distOverride: distPayload });
  } else {
    renderDistributionChart(datasetKey, { mapYear: dataYearNational });
  }
  const zonalForMetrics =
    index instanceof Map
      ? pickSubbasinZonalYearForCalendar(index, basinIndex, calendarYear, datasetKey)
      : rasterYear;
  updateBasinKeyMetrics(datasetKey, basinIndex, zonalForMetrics, calendarYear);
}

async function applyFiltersAsync() {
  const seq = ++applyFiltersSeq;
  const datasetSelect = document.getElementById("dataset-select");
  const fromInput = document.getElementById("year-from");
  const toInput = document.getElementById("year-to");
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");

  const datasetKey = datasetSelect.value;
  const selectedClasses = getSelectedClassNames();
  const basinIndices = getSelectedBasinIndices(); // null = national
  const fromYear = parseYearInputEl(fromInput);
  const toYear = parseYearInputEl(toInput);

  setYearSliderForDataset(datasetKey);
  const { calendarYear, rasterYear } = readYearSliderMapPair(datasetKey);
  if (yearLabel) {
    yearLabel.textContent = formatMapYearLabel(calendarYear, rasterYear);
    yearLabel.dataset.calendarYear = Number.isFinite(calendarYear) ? String(calendarYear) : "";
    yearLabel.dataset.rasterYear = Number.isFinite(rasterYear) ? String(rasterYear) : "";
  }

  let zonalYearForMetrics = rasterYear;
  const trendNote = document.getElementById("trend-scope-note");
  const distNote = document.getElementById("distribution-scope-note");
  const hint = document.getElementById("map-overlay-hint");

  setLegend(datasetKey, selectedClasses);

  // ── CHARTS FIRST — CSV data is already in memory, no network needed ─────────
  const dataYearNational = pickDataYearForCalendarYear(calendarYear, datasetKey);

  if (!basinIndices || !basinIndices.length) {
    if (trendNote) { trendNote.hidden = true; trendNote.textContent = ""; }
    if (distNote)  { distNote.hidden  = true; distNote.textContent  = ""; }
    renderTrendChart(datasetKey, selectedClasses, fromYear, toYear);
    renderDistributionChart(datasetKey, { mapYear: dataYearNational, selectedClasses });
  } else {
    const loaded = await ensureSubbasinZonalLoaded(datasetKey);
    if (seq !== applyFiltersSeq) return;

    if (!loaded) {
      if (trendNote) { trendNote.hidden = false; trendNote.textContent = "Sub-basin charts need zonal statistics for the selected basin."; }
      if (distNote)  { distNote.hidden  = false; distNote.textContent  = "Showing national totals until sub-basin data is available."; }
      renderTrendChart(datasetKey, selectedClasses, fromYear, toYear);
      renderDistributionChart(datasetKey, { mapYear: dataYearNational, selectedClasses });
    } else {
      const index = state.subbasinZonal[datasetKey];
      const zonalYearList = getZonalYearsForBasin(index, basinIndices[0]);
      if (trendNote) { trendNote.hidden = false; trendNote.textContent = `Trend and distribution use combined sub-basin aggregates (${basinIndices.length} basin${basinIndices.length > 1 ? "s" : ""}).`; }
      const zonalYear = pickSubbasinZonalYearForCalendar(index, basinIndices[0], calendarYear, datasetKey);
      zonalYearForMetrics = zonalYear;
      if (distNote) {
        distNote.hidden = false;
        distNote.textContent = Number.isFinite(zonalYear)
          ? `Distribution for zonal year ${zonalYear}${calendarYear !== zonalYear ? ` (slider: ${calendarYear})` : ""}.`
          : "Choose a map year on the slider.";
      }
      const trendPayload = buildSubbasinTrendPayload(
        index, basinIndices, selectedClasses, fromYear, toYear,
        zonalYearList.length ? zonalYearList : getYearsForMapSlider(datasetKey),
        datasetKey,
      );
      renderTrendChart(datasetKey, selectedClasses, fromYear, toYear, trendPayload);
      const distPayload = buildSubbasinDistPayload(index, basinIndices, zonalYear, datasetKey);
      renderDistributionChart(datasetKey, { distOverride: distPayload, selectedClasses });
    }
  }

  updateBasinKeyMetrics(datasetKey, basinIndices, zonalYearForMetrics, calendarYear);
  runChangeDetectionOutput().catch((e) => console.error(e));

  // ── RASTER OVERLAY — slow GeoTIFF fetch; happens after charts are already shown ─
  // basinIndices === null  → All Lithuania (national)
  // basinIndices is []     → nothing selected; clear overlay, show no coloring
  // basinIndices is [...]  → specific basins
  if (Array.isArray(basinIndices) && basinIndices.length === 0) {
    if (state.map.overlay) {
      state.map.instance?.removeLayer(state.map.overlay);
      state.map.overlay = null;
    }
    clearOverlayPaneMask(state.map.instance);
    applyBasinOutlineHighlight(null);
    if (hint) hint.textContent = "";
  } else {
    const classIds = selectedClasses.length < CANONICAL_CLASSES.length
      ? selectedClasses.map((c) => NAME_TO_CLASS_ID[c]).filter(Boolean)
      : null;

    await updateRasterOverlay(datasetKey, rasterYear, classIds, seq);
    if (seq !== applyFiltersSeq) return;

    if (state.map.instance) state.map.instance.invalidateSize();
    const mapInst = state.map.instance;
    if (mapInst) {
      if (basinIndices && basinIndices.length) {
        const features = basinIndices
          .map((i) => state.map.subbasins?.features?.[i])
          .filter(Boolean);
        applyOverlayPaneMask(features, mapInst);
        applyBasinOutlineHighlight(basinIndices);
      } else {
        clearOverlayPaneMask(mapInst);
        applyBasinOutlineHighlight(null);
      }
    }
    if (hint) hint.textContent = "";
  }
}

function applyFilters() {
  applyFiltersAsync().catch((e) => console.error(e));
}

let validationRmseChart = null;

/** Shared context so the Average/By-year toggle can re-render the RMSE chart
 * without re-running all the table/per-class-breakdown building logic. */
let validationTimelineCtx = {
  refKey: null,
  datasetKeys: [],
  labels: [],
  barColors: [],
  rmseVals: [],
  refLabel: "",
  mode: "average",
  years: [],
};

function setupTabs() {
  document.querySelectorAll(".tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-tab");
      document.querySelectorAll(".tabs .tab").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.getAttribute("data-panel") === name);
      });
      if (name === "validation") {
        loadValidationDashboard().catch((e) => console.error(e));
      }
    });
  });
}

function fmtValidation(x, decimals) {
  const d = decimals === undefined ? 4 : decimals;
  if (x === null || x === undefined || (typeof x === "number" && Number.isNaN(x))) return "—";
  return Number(x).toFixed(d);
}

/** @returns {object | null} */
function getValidationRefBlock(data, refKey) {
  if (data.references && data.references[refKey]) {
    return data.references[refKey];
  }
  if (refKey === "corine" && Array.isArray(data.national)) {
    return {
      national: data.national,
      subbasin_zonal: data.subbasin_zonal || {},
      description: data.description,
      subbasin_note: data.subbasin_note,
      label: "CORINE CLC",
      key: "corine",
    };
  }
  return null;
}

function bindValidationReferenceSelectOnce() {
  const sel = document.getElementById("validation-reference-select");
  if (!sel || sel.dataset.bound) return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", () => renderValidationRef(sel.value));
}

function renderValidationRef(refKey) {
  const data = state.validationMetrics;
  const descEl = document.getElementById("validation-description");
  const errEl = document.getElementById("validation-error");
  const tbody = document.getElementById("validation-summary-body");
  const perDs = document.getElementById("validation-per-dataset");
  const mlNote = document.getElementById("validation-ml-note");
  const canvas = document.getElementById("validation-rmse-chart");
  const titleEl = document.getElementById("validation-panel-title");
  if (!data || !tbody || !canvas || !descEl) return;

  const block = getValidationRefBlock(data, refKey);
  if (!block) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = `No validation block for reference "${refKey}".`;
    }
    return;
  }

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  if (titleEl) {
    titleEl.textContent = `Validation — ${block.label || refKey}`;
  }

  const genEl = document.getElementById("validation-generated");
  if (genEl) {
    if (data.generated_at) {
      genEl.hidden = false;
      const base = `Computed: ${data.generated_at}`;
      genEl.textContent =
        refKey === "grpk"
          ? `${base} · Single GRPK snapshot (national shares); see outputs/grpk_reference_shares.json.`
          : refKey === "corine"
            ? `${base} · CORINE years: ${(data.corine_years || []).join(", ")}`
            : `${base} · years: ${(block.national || []).flatMap((r) => r.years_used || []).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).join(", ")}`;
    } else {
      genEl.hidden = true;
      genEl.textContent = "";
    }
  }

  descEl.replaceChildren();
  descEl.append(
    document.createTextNode(
      block.description ||
        data.description ||
        "National shares; RMSE/MAE in share units (0–1).",
    ),
  );
  descEl.append(document.createTextNode(" "));
  const regen = document.createElement("span");
  regen.className = "validation-ml-note";
  regen.append("Regenerate ");
  const codeEl = document.createElement("code");
  codeEl.textContent =
    refKey === "grpk"
      ? "python analysis/build_grpk_reference.py && python analysis/compute_validation_metrics.py"
      : "python analysis/compute_validation_metrics.py";
  regen.append(codeEl);
  regen.append(" after changing outputs/*.csv.");
  descEl.append(regen);

  const footEl = document.getElementById("validation-footnotes");
  if (footEl) {
    if (refKey === "corine") {
      footEl.textContent = [
        "‡ Mean r: average of per-class correlations across years.",
        block.subbasin_note || "",
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      footEl.textContent = [block.subbasin_note || ""].filter(Boolean).join(" ");
    }
  }

  const sub = block.subbasin_zonal || {};
  const nationalRows = block.national || [];
  const classOrder = data.class_order || CANONICAL_CLASSES.slice();

  // Chart-ready labels/values (error rows are simply skipped, same as before).
  const validRows = nationalRows.filter((r) => !r.error);
  const labels = validRows.map((r) => r.dataset.toUpperCase());
  const rmseVals = validRows.map((r) => r.rmse_share_all);
  const barColors = ["#0ea5e9", "#22c55e", "#a855f7", "#f97316", "#6366f1"];

  renderSummaryAndBreakdown(nationalRows, classOrder, sub, block.error);

  const refLabel = block.label || refKey;

  // Reset the Average/By-year toggle back to Average whenever the reference
  // changes — the set of comparable years is different for every reference
  // (e.g. GRPK is a single fixed snapshot vs CORINE's sparse survey years),
  // so carrying a scrubbed year across references would often land nowhere.
  validationTimelineCtx = {
    refKey,
    datasetKeys: labels.map((l) => l.toLowerCase()),
    labels: labels.slice(),
    barColors: labels.map((_, i) => barColors[i % barColors.length]),
    rmseVals: rmseVals.slice(),
    refLabel,
    classOrder,
    averageRows: nationalRows.slice(),
    averageSubbasin: sub,
    mode: "average",
    years: [],
  };
  document.querySelectorAll(".validation-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === "average");
    // GRPK is a single fixed cadastre snapshot with no year of its own (see
    // grpk_reference_shares.json) -- every product year gets compared
    // against that same constant reference, so "By year" wouldn't scrub a
    // real GRPK timeline, just replay whichever OTHER dataset's own years
    // happen to have data (as far back as HILDA+'s 1900) against today's
    // parcels. That's a real computation but not a meaningful one to present
    // as a "year being compared" picker, so it's disabled for this reference
    // -- Average (all years) already aggregates correctly across each
    // product's own years vs the fixed snapshot.
    if (b.dataset.mode === "byyear") {
      b.disabled = refKey === "grpk";
      b.title = refKey === "grpk"
        ? "GRPK is a single fixed cadastre snapshot with no year of its own — use Average (all years) instead."
        : "";
    }
  });
  const timelineWrap = document.getElementById("validation-timeline-wrap");
  if (timelineWrap) timelineWrap.hidden = true;
  const yearNote = document.getElementById("validation-year-note");
  if (yearNote) yearNote.textContent = "";

  renderValidationAverageChart();
}

/** Builds the "National summary metrics" table + "Per-class breakdown"
 * details from a list of row objects — shared by the Average view (rows
 * come straight from dashboard_validation_metrics.json) and the By-year
 * view (rows are computed on the fly for a single scrubbed year). */
function renderSummaryAndBreakdown(rows, classOrder, subbasinMap, emptyMessage) {
  const tbody = document.getElementById("validation-summary-body");
  const perDs = document.getElementById("validation-per-dataset");
  const mlNote = document.getElementById("validation-ml-note");
  if (!tbody) return;

  // Per-class breakdown rows are rebuilt from scratch on every year change
  // (Average <-> By-year, or scrubbing the timeline) — remember which ones
  // the user had expanded so re-rendering doesn't silently collapse them.
  const openDatasets = new Set(
    perDs
      ? Array.from(perDs.querySelectorAll("details[open]")).map((d) => d.dataset.dataset)
      : [],
  );

  tbody.innerHTML = "";
  if (perDs) perDs.innerHTML = "";

  const sub = subbasinMap || {};
  const validRows = rows.filter((r) => !r.error && r.rmse_share_all != null);
  const bestRmse = validRows.length ? Math.min(...validRows.map((r) => r.rmse_share_all)) : null;

  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.className = "vmt-note-row";
    const td = document.createElement("td");
    td.colSpan = 10;
    td.textContent = emptyMessage || "No datasets to compare.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    if (row.error) {
      const tr = document.createElement("tr");
      tr.className = "vmt-note-row";
      const td = document.createElement("td");
      td.colSpan = 10;
      td.textContent = `${row.dataset}: ${row.error}`;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const sb = sub[row.dataset];
    const isBest = bestRmse != null && row.rmse_share_all === bestRmse;
    const dsLabel = DATASET_REGISTRY[row.dataset.toLowerCase()]?.label || row.dataset.toUpperCase();
    const tr = document.createElement("tr");
    if (isBest) tr.classList.add("vmt-best-row");
    tr.innerHTML = [
      `<td class="vmt-ds-name-cell">${dsLabel}${isBest ? '<span class="vmt-best-badge">lowest RMSE</span>' : ""}</td>`,
      `<td class="vmt-years-cell">${(row.years_used || []).join(", ")}</td>`,
      `<td class="num">${fmtValidation(row.rmse_share_all)}</td>`,
      `<td class="num">${fmtValidation(row.mae_share_all)}</td>`,
      `<td class="num">${fmtValidation(row.r2_flat)}</td>`,
      `<td class="num">${row.mean_pearson_r != null ? fmtValidation(row.mean_pearson_r) : "—"}</td>`,
      `<td class="num">${fmtValidation(row.cosine_similarity_mean)}</td>`,
      `<td class="num">${fmtValidation(row.ml_loyo_mean_rmse_rf)}</td>`,
      `<td class="num">${fmtValidation(row.ml_loyo_mean_rmse_ridge)}</td>`,
      `<td class="num">${sb ? fmtValidation(sb.mean_rmse_share_vs_corine) : "—"}</td>`,
    ].join("");
    tbody.appendChild(tr);

    const CLASS_SWATCHES = {
      Water: "#4DA6FF", Wetland: "#7B68EE", Urban: "#FF4D4D",
      Agriculture: "#FFD24D", Forest: "#228B22", "Natural (residual)": "#228B22",
    };

    const det = document.createElement("details");
    det.className = "validation-details";
    det.dataset.dataset = row.dataset;
    if (openDatasets.has(row.dataset)) det.open = true;
    const summ = document.createElement("summary");
    const yearsLabel = (row.years_used || []).length ? ` · ${(row.years_used || []).length} years` : "";
    summ.innerHTML = `<span class="vdet-ds-name">${dsLabel}</span><span class="vdet-ds-meta">${yearsLabel}</span>`;
    det.appendChild(summ);

    const tbl = document.createElement("table");
    tbl.className = "validation-mini-table";
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>Class</th><th class='num'>RMSE</th><th class='num'>MAE</th><th class='num'>Bias (pp)</th><th class='num'>r</th></tr>";
    tbl.appendChild(thead);
    const tb = document.createElement("tbody");
    const order = classOrder || ["Water", "Wetland", "Urban", "Agriculture", "Forest"];
    const pc = row.per_class || {};
    const pr = row.pearson_r_by_class || {};
    const presentList = row.classes_present_in_dataset;
    const hasPresent = Array.isArray(presentList) && presentList.length > 0;
    const present = new Set(hasPresent ? presentList : order);
    let anyAbsent = false;
    const absentTitle = "No mapped counts for this class in the product CSV.";
    order.forEach((cls) => {
      const inProduct = present.has(cls);
      if (hasPresent && !inProduct) anyAbsent = true;
      const p = pc[cls] || {};
      const r = pr[cls];
      const tr2 = document.createElement("tr");

      // Class name cell with color swatch
      const tdName = document.createElement("td");
      tdName.className = "vmt-class-cell";
      const swatch = document.createElement("span");
      swatch.className = "vmt-swatch";
      swatch.style.background = CLASS_SWATCHES[cls] || "#94a3b8";
      tdName.appendChild(swatch);
      tdName.appendChild(document.createTextNode(cls));
      tr2.appendChild(tdName);

      const addMetric = (val, decimals) => {
        const td = document.createElement("td");
        td.className = "num";
        if (inProduct && val != null && !Number.isNaN(val)) {
          td.textContent = fmtValidation(val, decimals);
        } else {
          td.textContent = "—";
          if (!inProduct) { td.classList.add("metric-na"); td.title = absentTitle; }
        }
        tr2.appendChild(td);
      };
      addMetric(p.rmse_share);
      addMetric(p.mae_share);

      // Bias cell — color coded
      const biasVal = p.bias_pp;
      const tdBias = document.createElement("td");
      tdBias.className = "num";
      if (inProduct && biasVal != null && !Number.isNaN(biasVal)) {
        tdBias.textContent = (biasVal > 0 ? "+" : "") + fmtValidation(biasVal, 2);
        if (Math.abs(biasVal) >= 0.5) tdBias.classList.add(biasVal > 0 ? "bias-pos" : "bias-neg");
      } else {
        tdBias.textContent = "—";
        if (!inProduct) { tdBias.classList.add("metric-na"); tdBias.title = absentTitle; }
      }
      tr2.appendChild(tdBias);

      const tdR = document.createElement("td");
      tdR.className = "num";
      if (inProduct) {
        tdR.textContent = r == null ? "—" : fmtValidation(r);
      } else {
        tdR.textContent = "—";
        tdR.classList.add("metric-na");
        tdR.title = absentTitle;
      }
      tr2.appendChild(tdR);
      tb.appendChild(tr2);
    });
    tbl.appendChild(tb);
    det.appendChild(tbl);
    if (anyAbsent) {
      const note = document.createElement("p");
      note.className = "validation-mini-footnote";
      note.textContent =
        "— (greyed) = class absent in the product CSV; headline metrics still use a full five-vector (zero for missing classes).";
      det.appendChild(note);
    }
    if (perDs) perDs.appendChild(det);
  });

  if (mlNote && rows[0] && rows[0].ml_note) {
    mlNote.textContent = rows[0].ml_note;
  } else if (mlNote) {
    mlNote.textContent = "";
  }
}

/** Average-across-years RMSE bar chart — the original/default view. */
function renderValidationAverageChart() {
  const canvas = document.getElementById("validation-rmse-chart");
  if (!canvas) return;
  const { labels, rmseVals, barColors, refLabel, averageRows, averageSubbasin, classOrder } =
    validationTimelineCtx;

  renderSummaryAndBreakdown(averageRows || [], classOrder, averageSubbasin || {});

  if (validationRmseChart) validationRmseChart.destroy();
  validationRmseChart = null;
  if (labels.length > 0) {
    const ctx = canvas.getContext("2d");
    validationRmseChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: `RMSE vs ${refLabel} (share 0–1)`,
            data: rmseVals,
            backgroundColor: barColors,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: `National RMSE vs ${refLabel} (share units) — average across all compared years`,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "RMSE" },
          },
          x: {
            title: { display: true, text: "Dataset" },
          },
        },
      },
    });
  }
}

/** National 5-class share vector [Water, Wetland, Urban, Agriculture, Forest]
 * (0–1) for one dataset at one year — same canonicalization used for the
 * Home tab's distribution chart, so it stays consistent across the app. */
function nationalShareVectorForYear(datasetKey, year) {
  const rows = state[datasetKey];
  if (!rows?.length || !Number.isFinite(year)) return null;
  const built = buildNationalDistributionForYear(rows, year, datasetKey);
  if (!built.labels.length) return null;
  const vec = CANONICAL_CLASSES.map(() => 0);
  built.labels.forEach((lbl, i) => {
    const canon = lbl === "Natural (residual)" ? "Forest" : lbl;
    const idx = CANONICAL_CLASSES.indexOf(canon);
    if (idx >= 0) vec[idx] = (built.values[i] || 0) / 100;
  });
  return vec;
}

function rmseVec(a, b) {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / a.length);
}

/** Fetches & caches the fixed GRPK PLOTAI reference share vector (single
 * cadastre snapshot — not a time series), in the same [Water, Wetland,
 * Urban, Agriculture, Forest] order as nationalShareVectorForYear(). */
async function getGrpkReferenceShares() {
  if (state.grpkReferenceShares) return state.grpkReferenceShares;
  try {
    const url = `${resolveDataFileUrl("outputs/grpk_reference_shares.json")}?t=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const order = Array.isArray(data.class_order) ? data.class_order : CANONICAL_CLASSES;
    const shares = Array.isArray(data.shares) ? data.shares : null;
    if (!shares) return null;
    const vec = CANONICAL_CLASSES.map(() => 0);
    order.forEach((cls, i) => {
      const idx = CANONICAL_CLASSES.indexOf(cls);
      if (idx >= 0) vec[idx] = Number(shares[i]) || 0;
    });
    state.grpkReferenceShares = vec;
    return vec;
  } catch (e) {
    console.error("Failed to load GRPK reference shares:", e);
    return null;
  }
}

/** Union of years across the compared product datasets (plus the reference
 * dataset's own years, when the reference itself varies by year), filtered
 * down to years where at least one dataset actually has a comparable value
 * against the reference — years where nothing at all lines up (e.g. a
 * product year far outside CORINE's sparse survey years) are dropped from
 * the scrubbable range entirely rather than landing on an empty chart. */
function getValidationTimelineYears(refKey, datasetKeys) {
  const set = new Set();
  datasetKeys.forEach((key) => {
    (state[key] || []).forEach((r) => {
      if (Number.isFinite(r.year)) set.add(r.year);
    });
  });
  if (refKey === "corine" || refKey === "esri") {
    (state[refKey] || []).forEach((r) => {
      if (Number.isFinite(r.year)) set.add(r.year);
    });
  }
  const candidates = Array.from(set)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  return candidates.filter((y) =>
    datasetKeys.some((key) => {
      const modVec = nationalShareVectorForYear(key, y);
      if (!modVec) return false;
      const refVec = refKey === "grpk" ? state.grpkReferenceShares : nationalShareVectorForYear(refKey, y);
      return !!refVec;
    }),
  );
}

/** Per-dataset RMSE vs the selected reference for exactly one year (or
 * null per-dataset when that dataset/reference has no data that year). */
async function computeValidationRmseAtYear(datasetKeys, refKey, year) {
  let grpkVec = null;
  if (refKey === "grpk") grpkVec = await getGrpkReferenceShares();
  return datasetKeys.map((key) => {
    const modVec = nationalShareVectorForYear(key, year);
    if (!modVec) return null;
    const refVec = refKey === "grpk" ? grpkVec : nationalShareVectorForYear(refKey, year);
    if (!refVec) return null;
    return rmseVec(modVec, refVec);
  });
}

/** Rebuilds the RMSE chart for a single scrubbed year (By-year mode). */
async function renderValidationChartForYear(year) {
  const canvas = document.getElementById("validation-rmse-chart");
  if (!canvas) return;
  const { datasetKeys, labels, barColors, refLabel, refKey } = validationTimelineCtx;
  const vals = await computeValidationRmseAtYear(datasetKeys, refKey, year);

  const label = document.getElementById("validation-year-label");
  if (label) label.textContent = String(year);
  const note = document.getElementById("validation-year-note");
  if (note) {
    const missing = labels.filter((_, i) => vals[i] == null);
    note.textContent = missing.length
      ? `No data for ${missing.join(", ")} in ${year} — bar omitted.`
      : "";
  }

  if (validationRmseChart) validationRmseChart.destroy();
  validationRmseChart = null;
  if (!labels.length) return;
  const ctx = canvas.getContext("2d");
  validationRmseChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `RMSE vs ${refLabel} (share 0–1) — ${year}`,
          data: vals,
          backgroundColor: barColors,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `RMSE vs ${refLabel} (share units) — ${year}`,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "RMSE" },
        },
        x: {
          title: { display: true, text: "Dataset" },
        },
      },
    },
  });
}

/** R² of a single reference/product pair of 5-class vectors (same formula
 * sklearn's r2_score uses, just inlined so per-year math stays client-side). */
function r2Score(yTrue, yPred) {
  const n = yTrue.length;
  const mean = yTrue.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (yTrue[i] - yPred[i]) ** 2;
    ssTot += (yTrue[i] - mean) ** 2;
  }
  if (ssTot < 1e-12) return null;
  return 1 - ssRes / ssTot;
}

function cosineSim(u, v) {
  const nu = Math.sqrt(u.reduce((s, x) => s + x * x, 0));
  const nv = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (nu < 1e-12 || nv < 1e-12) return 0;
  const dot = u.reduce((s, x, i) => s + x * v[i], 0);
  return dot / (nu * nv);
}

/** Per-year equivalent of the rows in dashboard_validation_metrics.json —
 * single-year RMSE/MAE/bias/R²/cosine per dataset vs the reference. Pearson
 * r and LOYO RMSE are inherently multi-year statistics and are left null
 * (shown as "—"); switch to Average for those. */
async function buildPerYearNationalRows(datasetKeys, refKey, year) {
  const grpkVec = refKey === "grpk" ? await getGrpkReferenceShares() : null;
  const eps = 1e-12;
  return datasetKeys.map((key) => {
    const modVec = nationalShareVectorForYear(key, year);
    if (!modVec) {
      return { dataset: key, error: `No data for year ${year}.` };
    }
    const refVec = refKey === "grpk" ? grpkVec : nationalShareVectorForYear(refKey, year);
    if (!refVec) {
      return { dataset: key, error: `Reference has no data for year ${year}.` };
    }
    const diff = modVec.map((v, i) => v - refVec[i]);
    const perClass = {};
    CANONICAL_CLASSES.forEach((cls, i) => {
      perClass[cls] = {
        rmse_share: Math.abs(diff[i]),
        mae_share: Math.abs(diff[i]),
        bias_pp: diff[i] * 100,
      };
    });
    return {
      dataset: key,
      years_used: [year],
      classes_present_in_dataset: CANONICAL_CLASSES.filter((_, i) => modVec[i] > eps),
      rmse_share_all: rmseVec(modVec, refVec),
      mae_share_all: diff.reduce((s, d) => s + Math.abs(d), 0) / diff.length,
      r2_flat: r2Score(refVec, modVec),
      pearson_r_by_class: {},
      mean_pearson_r: null,
      cosine_similarity_mean: cosineSim(modVec, refVec),
      per_class: perClass,
      ml_loyo_mean_rmse_rf: null,
      ml_loyo_mean_rmse_ridge: null,
      ml_note:
        "Single-year snapshot — Pearson r and LOYO RMSE need multiple years and aren't shown here; switch to Average for those.",
    };
  });
}

/** Mean sub-basin RMSE vs the reference for one product dataset at one year
 * — same definition as the Python pipeline's subbasin_mean_rmse(), just
 * computed for an arbitrary year from the already-loaded zonal CSVs instead
 * of the fixed year 2018. Not computed for GRPK (no zonal CSV for it). */
async function computeSubbasinRmseAtYear(productKey, refKey, year) {
  if (refKey === "grpk") return null;
  const [prodOk, refOk] = await Promise.all([
    ensureSubbasinZonalLoaded(productKey),
    ensureSubbasinZonalLoaded(refKey),
  ]);
  if (!prodOk || !refOk) return null;
  const prodIndex = state.subbasinZonal[productKey];
  const refIndex = state.subbasinZonal[refKey];
  if (!(prodIndex instanceof Map) || !(refIndex instanceof Map)) return null;

  const basinShares = (index, basinId) => {
    const cell = index.get(`${basinId}|${year}`);
    if (!cell || !cell.total || cell.total <= 0) return null;
    const total = cell.total;
    return [1, 2, 3, 4, 5].map((id) => (cell.counts[id] || 0) / total);
  };

  const basinIds = new Set();
  for (const key of prodIndex.keys()) {
    const [bidStr, yStr] = key.split("|");
    if (Number(yStr) === year) basinIds.add(Number(bidStr));
  }

  const rmses = [];
  basinIds.forEach((bid) => {
    const p = basinShares(prodIndex, bid);
    const r = basinShares(refIndex, bid);
    if (p && r) rmses.push(rmseVec(p, r));
  });
  if (!rmses.length) return null;
  return rmses.reduce((s, v) => s + v, 0) / rmses.length;
}

/** Rebuilds the RMSE chart AND the National summary table / Per-class
 * breakdown for a single scrubbed year — the By-year mode counterpart of
 * renderValidationAverageChart(), so every part of the page reflects the
 * selected year, not just the top chart. */
async function renderValidationDetailForYear(year) {
  await renderValidationChartForYear(year);
  const { datasetKeys, refKey, classOrder } = validationTimelineCtx;
  const rows = await buildPerYearNationalRows(datasetKeys, refKey, year);
  const subbasinEntries = await Promise.all(
    datasetKeys.map(async (key) => [
      key,
      { mean_rmse_share_vs_corine: await computeSubbasinRmseAtYear(key, refKey, year) },
    ]),
  );
  renderSummaryAndBreakdown(rows, classOrder, Object.fromEntries(subbasinEntries));
}

/** Picks the most useful year to land on when opening the timeline: the one
 * with the most datasets actually comparable that year (ties go to the most
 * recent), rather than blindly the latest year in the union — since e.g.
 * CORINE only has data at sparse survey years, the very latest year in the
 * union is often one where nothing lines up at all. */
function pickDefaultValidationYear(datasetKeys, refKey, years) {
  if (!years.length) return null;
  let bestYear = years[years.length - 1];
  let bestCount = -1;
  years.forEach((y) => {
    let count = 0;
    datasetKeys.forEach((key) => {
      if (!nationalShareVectorForYear(key, y)) return;
      const refVec = refKey === "grpk" ? state.grpkReferenceShares : nationalShareVectorForYear(refKey, y);
      if (refVec) count += 1;
    });
    if (count >= bestCount) {
      bestCount = count;
      bestYear = y;
    }
  });
  return bestYear;
}

/** Switches the timeline into By-year mode for the current reference:
 * computes the scrubbable year range and renders the most-comparable year. */
async function initValidationTimelineForCurrentRef() {
  if (validationTimelineCtx.refKey === "grpk") {
    await getGrpkReferenceShares();
  }
  const years = getValidationTimelineYears(
    validationTimelineCtx.refKey,
    validationTimelineCtx.datasetKeys,
  );
  validationTimelineCtx.years = years;

  const slider = document.getElementById("validation-year-slider");
  const yearInput = document.getElementById("validation-year-input");
  const note = document.getElementById("validation-year-note");
  if (!years.length || !slider) {
    if (note) {
      note.textContent =
        "No overlapping years available to build a per-year timeline for this reference.";
    }
    return;
  }
  slider.min = String(years[0]);
  slider.max = String(years[years.length - 1]);
  slider.step = "1";
  const initialYear = pickDefaultValidationYear(
    validationTimelineCtx.datasetKeys,
    validationTimelineCtx.refKey,
    years,
  );
  slider.value = String(initialYear);
  if (yearInput) yearInput.value = String(initialYear);
  await renderValidationDetailForYear(initialYear);
}

function setupValidationSubtabs() {
  const wrap = document.querySelector(".validation-subtabs");
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".validation-subtab");
    if (!btn) return;
    const name = btn.dataset.subtab;
    wrap.querySelectorAll(".validation-subtab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".validation-section[data-subtab-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.subtabPanel === name);
    });
  });
}

function setupValidationModeToggle() {
  const wrap = document.querySelector(".validation-mode-toggle");
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", async (e) => {
    const btn = e.target.closest(".validation-mode-btn");
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === validationTimelineCtx.mode) return;
    wrap.querySelectorAll(".validation-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    validationTimelineCtx.mode = mode;
    const timelineWrap = document.getElementById("validation-timeline-wrap");
    if (mode === "byyear") {
      if (timelineWrap) timelineWrap.hidden = false;
      await initValidationTimelineForCurrentRef();
    } else {
      if (timelineWrap) timelineWrap.hidden = true;
      const note = document.getElementById("validation-year-note");
      if (note) note.textContent = "";
      renderValidationAverageChart();
    }
  });
}

function setupValidationTimelineControls() {
  const slider = document.getElementById("validation-year-slider");
  if (!slider || slider.dataset.bound) return;
  slider.dataset.bound = "1";
  const label = document.getElementById("validation-year-label");
  const prevBtn = document.getElementById("validation-year-prev");
  const nextBtn = document.getElementById("validation-year-next");
  const yearInput = document.getElementById("validation-year-input");

  function nearestValidYear(raw) {
    const years = validationTimelineCtx.years;
    if (!years.length) return raw;
    return years.reduce(
      (best, y) => (Math.abs(y - raw) < Math.abs(best - raw) ? y : best),
      years[0],
    );
  }

  let debTimer = null;
  slider.addEventListener("input", () => {
    const raw = parseInt(slider.value, 10);
    const snapped = nearestValidYear(raw);
    if (snapped !== raw) slider.value = String(snapped);
    if (label) label.textContent = String(snapped);
    if (yearInput) yearInput.value = String(snapped);
    clearTimeout(debTimer);
    debTimer = setTimeout(() => renderValidationDetailForYear(snapped), 120);
  });

  prevBtn?.addEventListener("click", () => {
    const years = validationTimelineCtx.years;
    if (!years.length) return;
    const cur = parseInt(slider.value, 10);
    const idx = years.indexOf(cur);
    const prevYear = idx > 0 ? years[idx - 1] : years[0];
    slider.value = String(prevYear);
    slider.dispatchEvent(new Event("input"));
  });
  nextBtn?.addEventListener("click", () => {
    const years = validationTimelineCtx.years;
    if (!years.length) return;
    const cur = parseInt(slider.value, 10);
    const idx = years.indexOf(cur);
    const nextYear = idx >= 0 && idx < years.length - 1 ? years[idx + 1] : years[years.length - 1];
    slider.value = String(nextYear);
    slider.dispatchEvent(new Event("input"));
  });

  yearInput?.addEventListener("change", () => {
    const v = parseInt(yearInput.value, 10);
    if (!Number.isFinite(v)) return;
    slider.value = String(v);
    slider.dispatchEvent(new Event("input"));
  });
}

async function loadValidationDashboard() {
  const descEl = document.getElementById("validation-description");
  const errEl = document.getElementById("validation-error");
  const tbody = document.getElementById("validation-summary-body");
  const canvas = document.getElementById("validation-rmse-chart");
  if (!tbody || !canvas || !descEl) return;

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  try {
    const resp = await fetch(
      `${resolveDataFileUrl("outputs/dashboard_validation_metrics.json")}?t=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.validationMetrics = data;
    bindValidationReferenceSelectOnce();
    setupValidationSubtabs();
    setupValidationModeToggle();
    setupValidationTimelineControls();
    const sel = document.getElementById("validation-reference-select");
    const refKey = sel?.value || "corine";
    renderValidationRef(refKey);
  } catch (e) {
    state.validationMetrics = null;
    const genElErr = document.getElementById("validation-generated");
    if (genElErr) {
      genElErr.hidden = true;
      genElErr.textContent = "";
    }
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = `Could not load validation metrics (${e.message}).`;
    }
    if (validationRmseChart) {
      validationRmseChart.destroy();
      validationRmseChart = null;
    }
  }
}

/** Populate the About tab dataset cards from DATASET_REGISTRY. */
function renderAboutDatasetCards() {
  const container = document.getElementById("about-dataset-cards");
  if (!container) return;
  container.innerHTML = Object.entries(DATASET_REGISTRY).map(([, ds]) => `
    <div class="about-dataset-card">
      <div class="about-dataset-card-title">
        ${ds.label}
        ${ds.isValidation ? '<span class="about-dataset-badge">validation ref</span>' : ""}
      </div>
      <div class="about-dataset-card-meta">
        <span>Source</span><span>${ds.source}</span>
        <span>Period</span><span>${ds.temporal}</span>
        <span>Resolution</span><span>${ds.resolution}</span>
      </div>
      <p class="about-dataset-card-desc">${ds.description}</p>
      ${ds.notes.length ? `<ul class="about-dataset-card-notes">${ds.notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}
    </div>
  `).join("");
}

/** Update the dataset description hint shown below the dataset selector. */
function updateDatasetDescription() {
  const key = document.getElementById("dataset-select")?.value;
  const el = document.getElementById("dataset-description");
  if (!el) return;
  const ds = DATASET_REGISTRY[key];
  el.textContent = ds ? ds.description : "";
}

async function main() {
  // Read and immediately consume saved state from a dataset-switch reload.
  // Must happen before initMap() so the saved view can be applied on construction.
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem("_dashState") || "null"); } catch { return null; } })();
  sessionStorage.removeItem("_dashState");

  initMap(saved);
  setupTiledOverlayZoomHandling();
  setupTabs();
  setupMapOptions();
  setupHydroStationJump();
  setupHydroExpandModal();
  loadHydroPinsFromStorage();
  renderHydroPins();
  setupHydroPinsList();
  setupDashboardsTabs();
  setupHydrologyAboutToggle();
  setupHydroCardToggles();
  const basinHydrologyDataPromise = loadBasinHydrologyData().catch((e) => console.error(e));
  setupHydrologyYearSliderHook();
  setupLocationSearch();
  setupFloatingPanels();
  setupDashboardsPanel();
  setupDashboardsPanelResize();
  setupDashCardExpand();
  await loadData();

  renderAboutDatasetCards();
  updateDatasetDescription();

  const datasetSelect = document.getElementById("dataset-select");
  const yearSlider = document.getElementById("year-slider");
  const yearLabel = document.getElementById("year-label");

  function saveStateAndReload(overrideDataset, extra) {
    const key = overrideDataset ?? datasetSelect.value;
    const map = state.map.instance;
    const c = map ? map.getCenter() : null;
    const fromEl2    = document.getElementById("year-from");
    const toEl2      = document.getElementById("year-to");
    const sl2        = document.getElementById("year-slider");
    const opEl2      = document.getElementById("opacity-slider");
    const classAllCb = document.getElementById("class-all");
    const basinAllCb = document.getElementById("basin-all");
    sessionStorage.setItem("_dashState", JSON.stringify({
      dataset: key,
      mapLat:  c?.lat  ?? null,
      mapLng:  c?.lng  ?? null,
      mapZoom: map ? map.getZoom() : null,
      year:      sl2?.value    ?? null,
      yearFrom:  fromEl2?.value ?? null,
      yearTo:    toEl2?.value   ?? null,
      opacity:   opEl2?.value   ?? null,
      selectedClasses: classAllCb?.checked
        ? null
        : Array.from(document.querySelectorAll(".class-cb:checked")).map((cb) => cb.value),
      selectedBasins: basinAllCb?.checked
        ? null
        : Array.from(document.querySelectorAll(".basin-cb:checked")).map((cb) => parseInt(cb.value, 10)),
      mapOpts: { ...state.map.opts },
      ...extra,
    }));
    location.reload();
  }
  // Exposed at module scope so enterHydrologyMapMode (defined outside this
  // closure) can trigger the same save-and-reload path to force dataset=esri.
  saveStateAndReloadFn = saveStateAndReload;

  datasetSelect.addEventListener("change", () => markApplyPending());

  // Preserve hydrology mode across the reload Apply Filters triggers -- without
  // this, changing which basins are selected while already viewing the
  // Hydrology or Pinned tab silently dumped the user back on the
  // Land-coverage/Charts tab after every Apply, since only
  // enterHydrologyMapMode's OWN forced dataset=esri reload used to set
  // resumeDashTab.
  document.getElementById("apply-filters-btn")?.addEventListener("click", () => {
    const activeTab = document.querySelector(".dashboards-tab.active")?.dataset.dashtab;
    saveStateAndReload(undefined, state.map.hydrologyMapMode ? { resumeDashTab: activeTab || "hydrology" } : undefined);
  });

  const fromEl = document.getElementById("year-from");
  const toEl = document.getElementById("year-to");
  function clampAndFlipYearRange() {
    const csvYears = getCsvYearsSorted(datasetSelect.value);
    if (csvYears.length === 0) return;
    const minY = csvYears[0];
    const maxY = csvYears[csvYears.length - 1];
    let fromY = parseYearInputEl(fromEl);
    let toY = parseYearInputEl(toEl);
    if (Number.isFinite(fromY)) { fromY = Math.min(maxY, Math.max(minY, fromY)); fromEl.value = String(fromY); }
    if (Number.isFinite(toY))   { toY   = Math.min(maxY, Math.max(minY, toY));   toEl.value   = String(toY);   }
    if (Number.isFinite(fromY) && Number.isFinite(toY) && fromY > toY) {
      [fromEl.value, toEl.value] = [String(toY), String(fromY)];
    }
  }
  if (fromEl) fromEl.addEventListener("change", () => { clampAndFlipYearRange(); markApplyPending(); });
  if (toEl)   toEl.addEventListener("change",   () => { clampAndFlipYearRange(); markApplyPending(); });

  // Debounced so rapid slider drag ticks don't each trigger a raster fetch —
  // only the position you settle on (or pause on) actually applies.
  let yearSliderApplyTimer = null;
  yearSlider.addEventListener("input", () => {
    const key = datasetSelect.value;
    // Snap slider to nearest year that actually has data so dragging skips gaps.
    const rasterYs = getRasterYearsSorted(key);
    const validYears = rasterYs.length ? rasterYs : getYearsForMapSlider(key);
    if (validYears.length) {
      const raw = parseInt(yearSlider.value, 10);
      let best = validYears[0], bestDist = Math.abs(raw - best);
      for (const y of validYears) { const d = Math.abs(raw - y); if (d < bestDist) { bestDist = d; best = y; } }
      if (best !== raw) yearSlider.value = String(best);
    }
    const { calendarYear, rasterYear } = readYearSliderMapPair(key);
    yearLabel.textContent = formatMapYearLabel(calendarYear, rasterYear);
    yearLabel.dataset.calendarYear = Number.isFinite(calendarYear) ? String(calendarYear) : "";
    yearLabel.dataset.rasterYear = Number.isFinite(rasterYear) ? String(rasterYear) : "";
    const yi = document.getElementById("year-input");
    if (yi && Number.isFinite(calendarYear)) yi.value = String(calendarYear);

    clearTimeout(yearSliderApplyTimer);
    yearSliderApplyTimer = setTimeout(() => applyFilters(), 150);
  });

  function stepYear(delta) {
    const datasetKey = document.getElementById("dataset-select")?.value || "hildaknn";
    // Use confirmed raster years if scan has finished; fall back to CSV years.
    const rasterYs = getRasterYearsSorted(datasetKey);
    const validYears = rasterYs.length ? rasterYs : getYearsForMapSlider(datasetKey);
    const current = parseInt(yearSlider.value, 10);
    if (!validYears.length) {
      // Scan not done yet — simple ±1 fallback
      const lo = parseInt(yearSlider.min, 10) || 0;
      const hi = parseInt(yearSlider.max, 10) || 9999;
      yearSlider.value = String(Math.min(hi, Math.max(lo, current + delta)));
    } else if (delta > 0) {
      // Jump to the next year that actually has a raster/CSV file
      yearSlider.value = String(validYears.find((y) => y > current) ?? validYears[validYears.length - 1]);
    } else {
      // Jump to the previous year that actually exists
      const prev = [...validYears].reverse().find((y) => y < current);
      yearSlider.value = String(prev ?? validYears[0]);
    }
    yearSlider.dispatchEvent(new Event("input")); // live-applies via the debounced handler above
  }
  document.getElementById("year-prev")?.addEventListener("click", () => stepYear(-1));
  document.getElementById("year-next")?.addEventListener("click", () => stepYear(1));

  // Year number input — synced bidirectionally with the slider
  const yearInput = document.getElementById("year-input");
  if (yearInput) {
    yearInput.addEventListener("change", () => {
      const v = parseInt(yearInput.value, 10);
      if (!Number.isFinite(v)) return;
      const slider = document.getElementById("year-slider");
      const lo = parseInt(slider.min, 10) || 0;
      const hi = parseInt(slider.max, 10) || 9999;
      const clamped = Math.min(hi, Math.max(lo, v));
      slider.value = String(clamped);
      yearInput.value = String(clamped);
      slider.dispatchEvent(new Event("input")); // same live-update path as dragging the slider
    });
  }

  // Opacity slider
  const opacitySlider = document.getElementById("opacity-slider");
  const opacityValue = document.getElementById("opacity-value");
  if (opacitySlider) {
    opacitySlider.addEventListener("input", () => {
      const v = Number(opacitySlider.value);
      if (opacityValue) opacityValue.textContent = `${Math.round(v * 100)}%`;
      if (state.map.overlay && typeof state.map.overlay.setOpacity === "function") {
        state.map.overlay.setOpacity(v);
      }
      applyHydrologyRasterOpacity(); // no-op unless hydrology map mode is active
    });
  }



  // ── Multi-select checkbox panel wiring ──────────────────────────
  const allMsPanels = []; // for mutual exclusion

  function closeAllMsPanels(except) {
    allMsPanels.forEach(({ panel, toggle }) => {
      if (panel !== except) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    });
  }

  function setupMsPanel(toggleId, panelId, masterCbId, itemClass, allLabel, onChangeFn) {
    const toggle = document.getElementById(toggleId);
    const panel  = document.getElementById(panelId);
    const master = document.getElementById(masterCbId);
    if (!toggle || !panel || !master) return;

    allMsPanels.push({ panel, toggle });
    const refresh = () => updateMsToggleLabel(toggleId, masterCbId, itemClass, allLabel);

    // Open/close — close others first
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = panel.hidden;
      closeAllMsPanels(opening ? panel : null);
      panel.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== toggle) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    });

    // Master toggle
    master.addEventListener("change", () => {
      panel.querySelectorAll(`.${itemClass}`).forEach((cb) => { cb.checked = master.checked; });
      master.indeterminate = false;
      refresh();
      onChangeFn();
    });

    // Individual items (event delegation so it works for dynamically added basin checkboxes)
    panel.addEventListener("change", (e) => {
      if (!e.target.classList.contains(itemClass)) return;
      const all = Array.from(panel.querySelectorAll(`.${itemClass}`));
      const nChecked = all.filter((cb) => cb.checked).length;
      master.checked = nChecked === all.length;
      master.indeterminate = nChecked > 0 && nChecked < all.length;
      refresh();
      onChangeFn();
    });

    refresh();
  }

  // Class panel — changes only mark the Apply button as pending; map updates on button click.
  function markApplyPending() {
    const btn = document.getElementById("apply-filters-btn");
    if (btn) {
      btn.textContent = "Apply Filters ●";
      btn.style.background = "#b45309";
    }
  }
  setupMsPanel("class-ms-toggle", "class-ms-panel", "class-all", "class-cb", "All classes", markApplyPending);

  // Basin search filter
  document.getElementById("basin-search")?.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll(".basin-cb").forEach((cb) => {
      const item = cb.closest(".ms-item");
      if (item) item.style.display = !q || (cb.dataset.basinName || "").toLowerCase().includes(q) ? "" : "none";
    });
  });

  setupMsPanel("basin-ms-toggle", "basin-ms-panel", "basin-all", "basin-cb", "All Lithuania", markApplyPending);
  document.getElementById("basin-all")?.addEventListener("change", markApplyPending);

  // Pick initial dataset — prefer the one saved from a dataset-switch reload.
  let initialDataset = "hildaknn";
  if (saved?.dataset && state[saved.dataset]) {
    initialDataset = saved.dataset;
  } else if (state.hildaknn) initialDataset = "hildaknn";
  else if (state.lucas) initialDataset = "lucas";
  else if (state.hyde) initialDataset = "hyde";
  else if (state.luh2) initialDataset = "luh2";
  else if (state.esri) initialDataset = "esri";
  else if (state.grpk) initialDataset = "grpk";
  document.getElementById("dataset-select").value = initialDataset;
  populateClassDropdown(initialDataset);

  // Restore year range BEFORE setYearSliderForDataset so the slider clamps correctly.
  if (saved?.yearFrom) { const el = document.getElementById("year-from"); if (el) el.value = saved.yearFrom; }
  if (saved?.yearTo)   { const el = document.getElementById("year-to");   if (el) el.value = saved.yearTo;   }

  // Initial scan for raster years (so slider is sparse-but-clean)
  await scanRasterYears(initialDataset);
  setYearSliderForDataset(initialDataset);
  // Default: newest year; overridden below if a saved year exists.
  { const sl = document.getElementById("year-slider"); if (sl && Number(sl.max) > 0) sl.value = sl.max; }

  // Restore remaining UI state from the dataset-switch reload snapshot.
  if (saved) {
    const sl   = document.getElementById("year-slider");
    const opEl = document.getElementById("opacity-slider");
    const opVl = document.getElementById("opacity-value");

    if (saved.year && sl) sl.value = saved.year;

    if (saved.opacity) {
      if (opEl) opEl.value = saved.opacity;
      if (opVl) opVl.textContent = `${Math.round(Number(saved.opacity) * 100)}%`;
    }

    // Restore class checkboxes when a subset was selected (null = all selected, skip).
    if (Array.isArray(saved.selectedClasses)) {
      const allCb = document.getElementById("class-all");
      if (allCb) {
        const selSet = new Set(saved.selectedClasses);
        const items  = document.querySelectorAll(".class-cb");
        items.forEach((cb) => { cb.checked = selSet.has(cb.value); });
        const n = saved.selectedClasses.length;
        allCb.checked       = n === items.length;
        allCb.indeterminate = n > 0 && n < items.length;
        updateMsToggleLabel("class-ms-toggle", "class-all", "class-cb", "All classes");
      }
    }

    // Restore map options (basemap, labels, layer visibility toggles).
    if (saved.mapOpts) {
      Object.assign(state.map.opts, saved.mapOpts);
      syncMapOptsUI();
      applyBaseMap();
      applyOverlayVisibility();
    }
  }

  // Resume hydrology mode after the reload enterHydrologyMapMode triggered to
  // force dataset=esri (see that function), or after a normal Apply Filters
  // reload while already on the Hydrology tab. This MUST run after the
  // "saved.mapOpts" restoration directly above, not before it: that
  // restoration does Object.assign(state.map.opts, saved.mapOpts), which
  // would silently overwrite showHydroStations back to its pre-reload value
  // (usually false) the instant after entering hydrology mode had just set
  // it true -- the hydro-stations toggle would flip on and then immediately
  // back off before the user ever saw it. Also waits for
  // loadBasinHydrologyData() to finish first, since the click below runs
  // enterHydrologyMapMode() -> renderBasinHydrologySidebar(), which needs
  // basinCorrelationData already populated, and for the Filters basin
  // checkboxes to already be restored (done earlier, inside loadData()) so
  // enterHydrologyMapMode reads the actually-selected basins rather than
  // their pre-restoration default state.
  await basinHydrologyDataPromise;
  if (saved?.resumeDashTab) {
    document.querySelector(`.dashboards-tab[data-dashtab="${saved.resumeDashTab}"]`)?.click();
  }

  setLegend(initialDataset);
  applyFilters();
}

async function runChangeDetectionOutput() {
  const out = document.getElementById("change-detect-output");
  if (!out) return;
  const ds = document.getElementById("dataset-select")?.value || "hildaknn";
  const rows = state[ds];
  const fromInput = document.getElementById("year-from");
  const toInput = document.getElementById("year-to");
  const yFrom = parseYearInputEl(fromInput);
  const yTo = parseYearInputEl(toInput);
  if (!Number.isFinite(yFrom) || !Number.isFinite(yTo)) {
    out.innerHTML =
      "<p>Set <strong>From</strong> and <strong>To</strong> years in Filters, then click <strong>Apply filters</strong> to show the change table.</p>";
    return;
  }
  if (!rows?.length) {
    out.innerHTML = "<p>No time series loaded for this dataset.</p>";
    return;
  }

  const basinIndicesCD = getSelectedBasinIndices();
  const basinIndex = basinIndicesCD?.length === 1 ? basinIndicesCD[0] : NaN;
  const basinName = basinIndicesCD?.length === 1
    ? (document.querySelector(`.basin-cb[value="${basinIndex}"]`)?.dataset?.basinName || `Basin ${basinIndex + 1}`)
    : basinIndicesCD?.length > 1 ? `${basinIndicesCD.length} basins` : "";
  const order = nationalDistributionClassLabels(ds);

  const renderTable = (metaHtml, yA, yB, pa, pb) => {
    const rowsHtml = order
      .map((lb) => {
        const va = pa[lb] ?? 0;
        const vb = pb[lb] ?? 0;
        const d = vb - va;
        const sign = d > 0 ? "+" : "";
        return `<tr><td>${lb}</td><td class="num">${va.toFixed(1)}%</td><td class="num">${vb.toFixed(1)}%</td><td class="num">${sign}${d.toFixed(1)}%</td></tr>`;
      })
      .join("");
    out.innerHTML = `${metaHtml}<table class="change-detect-table"><thead><tr><th>Class</th><th>${yA}</th><th>${yB}</th><th>Δ</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  };

  if (Number.isFinite(basinIndex)) {
    await ensureSubbasinZonalLoaded(ds);
    const index = state.subbasinZonal[ds];
    if (!(index instanceof Map)) {
      out.innerHTML = "<p>Zonal statistics are not available for this dataset.</p>";
      return;
    }
    const rA = pickSubbasinZonalYearForCalendar(index, basinIndex, yFrom, ds);
    const rB = pickSubbasinZonalYearForCalendar(index, basinIndex, yTo, ds);
    const a = buildSubbasinDistPayload(index, basinIndex, rA, ds);
    const b = buildSubbasinDistPayload(index, basinIndex, rB, ds);
    if (!a.labels.length || !b.labels.length) {
      out.innerHTML = "<p>No sub-basin data for those years (check zonal CSV / raster exports).</p>";
      return;
    }
    const pa = {};
    const pb = {};
    a.labels.forEach((lb, i) => {
      pa[lb] = a.values[i];
    });
    b.labels.forEach((lb, i) => {
      pb[lb] = b.values[i];
    });
    const extra =
      rA !== yFrom || rB !== yTo
        ? ` Table headers use your filter years (${yFrom}, ${yTo}); values use the nearest sub-basin zonal years <strong>${rA}</strong> and <strong>${rB}</strong> (floor to available zonal exports, same idea as the map year slider).`
        : "";
    renderTable(
      `<p class="change-detect-meta">Sub-basin: <strong>${basinName}</strong>.${extra}</p>`,
      yFrom,
      yTo,
      pa,
      pb,
    );
    return;
  }

  const dFrom = pickDataYearForCalendarYear(yFrom, ds);
  const dTo = pickDataYearForCalendarYear(yTo, ds);
  const a = buildNationalDistributionForYear(rows, dFrom, ds);
  const b = buildNationalDistributionForYear(rows, dTo, ds);
  if (!a.labels.length || !b.labels.length) {
    out.innerHTML = "<p>No national class totals for at least one of those years (after snapping to available CSV years).</p>";
    return;
  }
  const pa = {};
  const pb = {};
  a.labels.forEach((lb, i) => {
    pa[lb] = a.values[i];
  });
  b.labels.forEach((lb, i) => {
    pb[lb] = b.values[i];
  });
  const natExtra =
    dFrom !== yFrom || dTo !== yTo
      ? ` Filter years ${yFrom}→<strong>${dFrom}</strong>, ${yTo}→<strong>${dTo}</strong> (nearest year with national rows, same as the donut).`
      : "";
  renderTable(
    `<p class="change-detect-meta">National (whole Lithuania), dataset <strong>${ds}</strong>. Δ is the difference between the two percentage columns (percentage points), shown with a % sign.${natExtra}</p>`,
    dFrom,
    dTo,
    pa,
    pb,
  );
}

document.addEventListener("DOMContentLoaded", main);

