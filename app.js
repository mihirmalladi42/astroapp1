const SKYVIEW_ENDPOINT = "https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl";

const state = {
  stream: null,
  location: null,
  rawPointing: null,
  stableRawPointing: null,
  pointing: null,
  lastResolvedAt: 0,
  lastResolvedKey: "",
  running: false,
  survey: "DSS2 Red",
  fov: 5,
  pixels: 768,
  target: null,
  headingSource: "",
  magneticDeclinationDeg: null,
  compassAccuracyDeg: null,
  calibration: null,
  alignmentSamples: [],
  alignStarMode: false,
  calibrating: false,
};

const camera = document.querySelector("#camera");
const skyImage = document.querySelector("#skyImage");
const catalog = window.ASTRO_CATALOG || { objects: [], counts: {} };
const startButton = document.querySelector("#startButton");
const catalogButton = document.querySelector("#catalogButton");
const catalogPanel = document.querySelector("#catalogPanel");
const catalogSearch = document.querySelector("#catalogSearch");
const catalogFilter = document.querySelector("#catalogFilter");
const typeFilter = document.querySelector("#typeFilter");
const aboveHorizonFilter = document.querySelector("#aboveHorizonFilter");
const alignStarsButton = document.querySelector("#alignStarsButton");
const clearAlignButton = document.querySelector("#clearAlignButton");
const catalogCount = document.querySelector("#catalogCount");
const catalogResults = document.querySelector("#catalogResults");
const guideIndicator = document.querySelector("#guideIndicator");
const guideTarget = document.querySelector("#guideTarget");
const guideDirection = document.querySelector("#guideDirection");
const targetCheck = document.querySelector("#targetCheck");
const resolveButton = document.querySelector("#resolveButton");
const imageLink = document.querySelector("#imageLink");
const calibrateButton = document.querySelector("#calibrateButton");
const restartCameraButton = document.querySelector("#restartCameraButton");
const statusEl = document.querySelector("#status");
const azimuthValue = document.querySelector("#azimuthValue");
const altitudeValue = document.querySelector("#altitudeValue");
const raValue = document.querySelector("#raValue");
const decValue = document.querySelector("#decValue");
const utcValue = document.querySelector("#utcValue");
const coordsValue = document.querySelector("#coordsValue");

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MAX_RESULTS = 60;
const ALIGNMENT_MIN_SAMPLES = 3;
const ALIGNMENT_MAX_SAMPLES = 6;
const ALIGNMENT_LOW_ALT_MIN = 8;
const ALIGNMENT_LOW_ALT_MAX = 50;
const HIGH_ALT_AZ_GUARD_MIN_ALT = 35;
const AZ_SPIKE_DEG = 55;
const infoCache = new Map();
const SOLAR_SYSTEM_BODIES = [
  { id: "Sun", name: "Sun", body: "Sun", type: "star", aliases: ["Sol"] },
  { id: "Moon", name: "Moon", body: "Moon", type: "moon", aliases: ["Luna"] },
  { id: "Mercury", name: "Mercury", body: "Mercury", type: "planet", aliases: [] },
  { id: "Venus", name: "Venus", body: "Venus", type: "planet", aliases: [] },
  { id: "Mars", name: "Mars", body: "Mars", type: "planet", aliases: [] },
  { id: "Jupiter", name: "Jupiter", body: "Jupiter", type: "planet", aliases: [] },
  { id: "Saturn", name: "Saturn", body: "Saturn", type: "planet", aliases: [] },
  { id: "Uranus", name: "Uranus", body: "Uranus", type: "planet", aliases: [] },
  { id: "Neptune", name: "Neptune", body: "Neptune", type: "planet", aliases: [] },
];

startButton.addEventListener("click", startExperience);
catalogButton.addEventListener("click", toggleCatalogPanel);
catalogSearch.addEventListener("input", renderCatalogResults);
catalogFilter.addEventListener("change", renderCatalogResults);
typeFilter.addEventListener("change", renderCatalogResults);
aboveHorizonFilter.addEventListener("change", renderCatalogResults);
alignStarsButton.addEventListener("click", showAlignStars);
clearAlignButton.addEventListener("click", clearAlignment);
resolveButton.addEventListener("click", () => resolveSky(true));
imageLink.addEventListener("click", openResolvedImage);
calibrateButton.addEventListener("click", calibrateToTarget);
restartCameraButton.addEventListener("click", restartLiveCamera);

renderCatalogResults();

function setStatus(message) {
  statusEl.textContent = message;
}

async function startExperience() {
  startButton.disabled = true;
  setStatus("Requesting camera, location, and orientation.");

  try {
    await requestOrientationPermission();
    await startCamera();
    await getLocation();
    window.addEventListener("deviceorientation", handleOrientation, true);
    window.addEventListener("deviceorientationabsolute", handleOrientation, true);

    state.running = true;
    resolveButton.disabled = false;
    startButton.textContent = "Running";
    setStatus("Point at the sky, then tap Resolve to create a SkyView image link.");
  } catch (error) {
    startButton.disabled = false;
    setStatus(error.message || "Could not start sensors.");
  }
}

async function requestOrientationPermission() {
  const orientation = window.DeviceOrientationEvent;

  if (!orientation) {
    throw new Error("This browser does not expose phone orientation sensors.");
  }

  if (typeof orientation.requestPermission === "function") {
    const permission = await orientation.requestPermission();
    if (permission !== "granted") {
      throw new Error("Orientation permission was not granted.");
    }
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot open the camera.");
  }

  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  camera.srcObject = state.stream;
  await camera.play();
}

function getLocation() {
  if (!navigator.geolocation) {
    throw new Error("This browser cannot read location.");
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        try {
          state.location = {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          };
          state.magneticDeclinationDeg = SkyLensPointing.magneticDeclinationDeg(
            window.Geomagnetism,
            state.location.lat,
            state.location.lon,
            new Date(),
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      () => reject(new Error("Location permission was not granted.")),
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 12000,
      },
    );
  });
}

function handleOrientation(event) {
  if (state.headingSource === "webkit" && !Number.isFinite(event.webkitCompassHeading)) {
    return;
  }

  const orientation = SkyLensPointing.readRearCameraPointing(
    event,
    state.magneticDeclinationDeg,
  );

  if (!orientation.valid) {
    if (orientation.reason === "compass-uncalibrated") {
      setStatus("Compass needs calibration. Move the phone in a figure eight, then aim again.");
      return;
    }
    if (state.headingSource) return;
    setStatus("Move the phone in a figure eight if the compass is not ready.");
    return;
  }

  state.headingSource = orientation.source;
  state.compassAccuracyDeg = orientation.compassAccuracyDeg;
  const measuredPointing = {
    azDeg: orientation.azDeg,
    altDeg: clamp(orientation.altDeg, -90, 90),
    timestamp: Date.now(),
  };
  state.rawPointing = stabilizedRawPointing(measuredPointing);
  state.pointing = calibratedPointing(state.rawPointing);

  renderPointing();
}

function stabilizedRawPointing(pointing) {
  const previous = state.stableRawPointing;
  const alignmentActive = state.alignmentSamples.length >= ALIGNMENT_MIN_SAMPLES;

  if (!previous) {
    state.stableRawPointing = { ...pointing };
    return { ...pointing };
  }

  let azDeg = pointing.azDeg;
  const altDeg = pointing.altDeg;
  const highAltitude = Math.abs(altDeg) >= HIGH_ALT_AZ_GUARD_MIN_ALT;

  if (highAltitude && alignmentActive) {
    azDeg = nearestEquivalentAzimuth(azDeg, previous.azDeg);

    const deltaAz = signedDeltaDeg(azDeg, previous.azDeg);
    const deltaAlt = Math.abs(altDeg - previous.altDeg);
    const looksLikeCompassSpike = Math.abs(deltaAz) >= AZ_SPIKE_DEG && deltaAlt < 8;

    if (looksLikeCompassSpike) {
      azDeg = previous.azDeg;
    }
  }

  const stabilized = {
    azDeg: normalizeDegrees(azDeg),
    altDeg,
    timestamp: pointing.timestamp,
  };
  state.stableRawPointing = stabilized;
  return { ...stabilized };
}

function nearestEquivalentAzimuth(azDeg, referenceAzDeg) {
  const candidates = [
    normalizeDegrees(azDeg),
    normalizeDegrees(azDeg + 180),
    normalizeDegrees(azDeg - 180),
  ];

  return candidates.reduce((best, candidate) => (
    Math.abs(signedDeltaDeg(candidate, referenceAzDeg)) < Math.abs(signedDeltaDeg(best, referenceAzDeg))
      ? candidate
      : best
  ), candidates[0]);
}

function renderPointing() {
  const pointing = state.pointing;
  if (!pointing || !state.location) return;

  const now = new Date();
  const equatorial = horizontalToEquatorial(
    pointing.azDeg,
    pointing.altDeg,
    state.location.lat,
    state.location.lon,
    now,
  );

  azimuthValue.textContent = `${pointing.azDeg.toFixed(1)} deg`;
  altitudeValue.textContent = `${pointing.altDeg.toFixed(1)} deg`;
  raValue.textContent = formatRa(equatorial.raDeg);
  decValue.textContent = formatDec(equatorial.decDeg);
  utcValue.textContent = formatUtc(now);
  coordsValue.textContent = formatCoords(state.location.lat, state.location.lon);
  updateGuide(now);
}

function resolveSky(force) {
  if (!state.location || !state.pointing) return;

  const age = Date.now() - state.pointing.timestamp;
  if (age > 5000) {
    setStatus("Waiting for fresh orientation data.");
    return;
  }

  const equatorial = horizontalToEquatorial(
    state.pointing.azDeg,
    state.pointing.altDeg,
    state.location.lat,
    state.location.lon,
    new Date(),
  );

  const key = `${Math.round(equatorial.raDeg * 20)}:${Math.round(equatorial.decDeg * 20)}`;
  if (!force && key === state.lastResolvedKey) return;

  const url = skyViewUrl(equatorial.raDeg, equatorial.decDeg);
  state.lastResolvedAt = Date.now();
  state.lastResolvedKey = key;
  skyImage.removeAttribute("src");
  skyImage.classList.remove("visible");
  setResolvedImageLink(url);
  restartCameraButton.classList.remove("hidden");
  setStatus(`Resolved image link ready: RA ${formatRa(equatorial.raDeg)}, Dec ${formatDec(equatorial.decDeg)}.`);
}

function toggleCatalogPanel() {
  catalogPanel.classList.toggle("hidden");
  if (!catalogPanel.classList.contains("hidden")) {
    catalogSearch.focus();
    renderCatalogResults();
  }
}

function showAlignStars() {
  state.alignStarMode = true;
  catalogSearch.value = "";
  catalogFilter.value = "star";
  typeFilter.value = "star";
  aboveHorizonFilter.checked = true;
  catalogPanel.classList.remove("hidden");
  renderCatalogResults();
  setStatus("Choose a recommended low star, tap Guide, center it, then tap Add align star.");
}

function renderCatalogResults() {
  if (!catalog.objects.length) {
    catalogCount.textContent = "Catalog did not load.";
    catalogResults.innerHTML = "";
    return;
  }

  const now = new Date();
  const query = catalogSearch.value.trim().toLowerCase();
  const selectedCatalog = catalogFilter.value;
  const selectedType = typeFilter.value;
  const onlyAboveHorizon = aboveHorizonFilter.checked;
  const alignMode = state.alignStarMode && !query;
  const objects = alignMode ? recommendedAlignStars(now) : catalogObjects(now);
  const matches = [];

  for (const object of objects) {
    if (selectedCatalog !== "all" && object.catalog !== selectedCatalog) continue;
    if (!matchesType(object, selectedType)) continue;
    if (onlyAboveHorizon && !isAboveHorizon(object, now)) continue;
    if (query && !searchText(object).includes(query)) continue;
    matches.push(object);
  }

  if (query) {
    state.alignStarMode = false;
    matches.sort((a, b) => relevanceScore(a, query) - relevanceScore(b, query));
  } else if (alignMode) {
    matches.sort((a, b) => alignStarScore(a) - alignStarScore(b));
  }

  const visibleMatches = matches.slice(0, MAX_RESULTS);

  const totalText = catalog.counts.total ? `${objects.length.toLocaleString()} objects` : "catalog";
  const horizonText = onlyAboveHorizon ? " above horizon" : "";
  catalogCount.textContent = alignMode
    ? `${visibleMatches.length.toLocaleString()} guided alignment stars shown. Add ${Math.max(0, ALIGNMENT_MIN_SAMPLES - state.alignmentSamples.length)} more for alignment.`
    : `${visibleMatches.length.toLocaleString()} shown from ${matches.length.toLocaleString()} matches${horizonText} in ${totalText}`;
  catalogResults.innerHTML = "";

  if (onlyAboveHorizon && !state.location) {
    catalogCount.textContent = "Start sensors first so the app can filter targets above your local horizon.";
  }

  if (selectedCatalog === "solar" && !solarSystemAvailable()) {
    catalogCount.textContent = "Solar System positions need the local ephemeris file to load.";
  }

  for (const object of visibleMatches) {
    const row = document.createElement("div");
    row.className = "catalog-result";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    title.textContent = object.name === object.id ? object.id : `${object.id} - ${object.name}`;
    const altAz = object.altAz;
    const skyText = altAz ? ` | Alt ${altAz.altDeg.toFixed(1)} deg, Az ${altAz.azDeg.toFixed(1)} deg` : "";
    meta.textContent = `${catalogLabel(object.catalog)} | ${typeLabel(object.type)}${skyText} | RA ${object.ra.toFixed(4)} deg, Dec ${object.dec.toFixed(4)} deg`;
    details.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "catalog-actions";

    const infoButton = document.createElement("button");
    infoButton.type = "button";
    infoButton.textContent = "Info";
    infoButton.addEventListener("click", () => showCatalogInfo(object, row, infoButton));

    const guideButton = document.createElement("button");
    guideButton.type = "button";
    guideButton.textContent = "Guide";
    guideButton.addEventListener("click", () => resolveCatalogObject(object));

    actions.append(infoButton, guideButton);
    row.append(details, actions);
    catalogResults.append(row);
  }

  if (visibleMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "catalog-count";
    empty.textContent = "No matches.";
    catalogResults.append(empty);
  }
}

function recommendedAlignStars(date) {
  if (!state.location) return [];

  return catalog.objects
    .filter((object) => object.catalog === "star" && Number.isFinite(object.mag) && object.mag <= 3.2)
    .map((object) => {
      const altAz = equatorialToHorizontal(object.ra, object.dec, state.location.lat, state.location.lon, date);
      return { ...object, altAz };
    })
    .filter((object) => object.altAz.altDeg >= ALIGNMENT_LOW_ALT_MIN && object.altAz.altDeg <= ALIGNMENT_LOW_ALT_MAX)
    .sort((a, b) => alignStarScore(a) - alignStarScore(b))
    .slice(0, 30);
}

function alignStarScore(object) {
  const altitudeCost = Math.abs((object.altAz?.altDeg ?? 28) - 28);
  const brightnessCost = Number.isFinite(object.mag) ? object.mag * 4 : 20;
  const usedCost = state.alignmentSamples.some((sample) => sample.id === object.id) ? 100 : 0;
  return altitudeCost + brightnessCost + usedCost;
}

function catalogObjects(date) {
  return [...solarSystemCatalogObjects(date), ...catalog.objects];
}

function solarSystemAvailable() {
  return typeof window.Astronomy === "object" && typeof window.Astronomy.Equator === "function";
}

function solarSystemCatalogObjects(date) {
  if (!solarSystemAvailable()) return [];

  const objects = [];
  for (const body of SOLAR_SYSTEM_BODIES) {
    const position = solarSystemPosition(body, date);
    if (position) objects.push(position);
  }
  return objects;
}

function solarSystemPosition(body, date) {
  const Astronomy = window.Astronomy;
  const observer = astronomyObserver();

  try {
    const equ2000 = Astronomy.Equator(body.body, date, observer, false, true);
    const equOfDate = Astronomy.Equator(body.body, date, observer, true, true);
    const horizon = Astronomy.Horizon(date, observer, equOfDate.ra, equOfDate.dec, "normal");
    const distanceAu = Number.isFinite(equ2000.dist) ? equ2000.dist : null;

    return {
      id: body.id,
      name: body.name,
      catalog: "solar",
      type: body.type,
      ra: normalizeDegrees(equ2000.ra * 15),
      dec: equ2000.dec,
      aliases: body.aliases,
      body: body.body,
      dynamic: true,
      distanceAu,
      altAz: {
        azDeg: normalizeDegrees(horizon.azimuth),
        altDeg: horizon.altitude,
      },
      source: ["astronomy-engine"],
    };
  } catch (error) {
    return null;
  }
}

function astronomyObserver() {
  const Astronomy = window.Astronomy;
  const lat = state.location?.lat ?? 0;
  const lon = state.location?.lon ?? 0;
  return new Astronomy.Observer(lat, lon, 0);
}

function currentCatalogObject(object, date = new Date()) {
  if (object.catalog !== "solar") return object;
  return solarSystemPosition(object, date) || object;
}

function isAboveHorizon(object, date) {
  if (!state.location) return false;

  const currentObject = currentCatalogObject(object, date);
  const altAz = currentObject.altAz || equatorialToHorizontal(
    currentObject.ra,
    currentObject.dec,
    state.location.lat,
    state.location.lon,
    date,
  );
  return altAz.altDeg > 0;
}

async function showCatalogInfo(object, row, button) {
  const existing = row.querySelector(".catalog-info");
  if (existing) {
    existing.classList.toggle("hidden");
    return;
  }

  const info = document.createElement("p");
  info.className = "catalog-info";
  info.textContent = "Loading info...";
  row.append(info);

  button.disabled = true;
  try {
    const details = await objectInfo(object);
    info.textContent = details.text;

    if (details.url) {
      const source = document.createElement("a");
      source.href = details.url;
      source.target = "_blank";
      source.rel = "noreferrer";
      source.textContent = " Source";
      info.append(source);
    }
  } catch (error) {
    info.textContent = localObjectInfo(object);
  } finally {
    button.disabled = false;
  }
}

async function objectInfo(object) {
  const key = object.id;
  if (infoCache.has(key)) return infoCache.get(key);

  const summary = await wikipediaSummary(object);
  const result = summary
    ? { text: summary.extract, url: summary.content_urls?.desktop?.page || summary.content_urls?.mobile?.page || "" }
    : { text: localObjectInfo(object), url: "" };
  infoCache.set(key, result);
  return result;
}

async function wikipediaSummary(object) {
  const query = wikipediaQuery(object);
  const searchUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
    format: "json",
    origin: "*",
  }).toString()}`;
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) return null;

  const searchData = await searchResponse.json();
  const title = searchData.query?.search?.[0]?.title;
  if (!title) return null;

  const summaryResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!summaryResponse.ok) return null;

  const summary = await summaryResponse.json();
  if (!summary.extract || summary.type === "disambiguation") return null;
  return summary;
}

function wikipediaQuery(object) {
  if (object.catalog === "messier") return `${object.id.replace(/^M/i, "Messier ")} astronomy`;
  if (object.catalog === "ngc") return `${object.id} astronomy`;
  if (object.catalog === "caldwell") return `${object.name} ${object.id} astronomy`;
  if (object.catalog === "star") return `${object.name} star`;
  if (object.catalog === "solar") return object.id === "Sun" ? "Sun astronomy" : `${object.id} astronomy`;
  return `${object.name || object.id} astronomy`;
}

function localObjectInfo(object) {
  const title = object.name === object.id ? object.id : `${object.id} (${object.name})`;
  if (object.catalog === "solar") {
    const currentObject = currentCatalogObject(object);
    const distance = formatSolarDistance(currentObject);
    return `${title} is a moving Solar System target. Its RA/Dec are calculated live for the current UTC time${state.location ? " and your location" : ""}. Current position: RA ${formatRa(currentObject.ra)}, Dec ${formatDec(currentObject.dec)}${distance ? `, distance ${distance}` : ""}.`;
  }
  return `${title} is listed locally as ${catalogLabel(object.catalog)} / ${typeLabel(object.type)} at RA ${formatRa(object.ra)} and Dec ${formatDec(object.dec)}. Discovery date, discoverer, and distance were not available from the live info source.`;
}

function resolveCatalogObject(object) {
  const currentObject = currentCatalogObject(object);
  const url = skyViewUrl(currentObject.ra, currentObject.dec);
  state.target = object;
  state.lastResolvedAt = Date.now();
  state.lastResolvedKey = `catalog:${object.id}`;
  skyImage.removeAttribute("src");
  skyImage.classList.remove("visible");
  setResolvedImageLink(url);
  calibrateButton.classList.remove("hidden");
  restartCameraButton.classList.remove("hidden");
  raValue.textContent = formatRa(currentObject.ra);
  decValue.textContent = formatDec(currentObject.dec);
  catalogPanel.classList.add("hidden");
  updateGuide(new Date());
  setStatus(`Catalog target ready: ${object.id} at RA ${formatRa(currentObject.ra)}, Dec ${formatDec(currentObject.dec)}.`);
}

async function calibrateToTarget() {
  if (!state.target || !state.rawPointing || !state.location) {
    setStatus("Select a target and start sensors before calibrating.");
    return;
  }
  if (state.calibrating) return;

  state.calibrating = true;
  calibrateButton.disabled = true;
  setStatus(`Hold ${state.target.id} centered. Sampling alignment...`);

  try {
    const rawAverage = await averagedRawPointing(2600);
    const date = new Date();
    const target = currentCatalogObject(state.target, date);
    const targetAltAz = objectAltAz(target, date);

    addAlignmentSample({
      id: target.id,
      name: target.name,
      measuredAzDeg: rawAverage.azDeg,
      measuredAltDeg: rawAverage.altDeg,
      trueAzDeg: targetAltAz.azDeg,
      trueAltDeg: targetAltAz.altDeg,
      count: rawAverage.count,
      timestamp: Date.now(),
    });
  } catch (error) {
    setStatus(error.message || "Alignment failed. Hold steadier and try again.");
  } finally {
    state.calibrating = false;
    calibrateButton.disabled = false;
  }
}

function addAlignmentSample(sample) {
  const withoutSameTarget = state.alignmentSamples.filter((existing) => existing.id !== sample.id);
  state.alignmentSamples = [...withoutSameTarget, sample]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ALIGNMENT_MAX_SAMPLES);

  state.calibration = {
    azOffsetDeg: signedDeltaDeg(sample.trueAzDeg, sample.measuredAzDeg),
    altOffsetDeg: sample.trueAltDeg - sample.measuredAltDeg,
    targetId: sample.id,
    mode: "target",
    timestamp: sample.timestamp,
  };

  refreshCalibrationState();

  const needed = Math.max(0, ALIGNMENT_MIN_SAMPLES - state.alignmentSamples.length);
  const readyText = needed
    ? `${needed} more star${needed === 1 ? "" : "s"} needed.`
    : `Multi-star alignment active with ${state.alignmentSamples.length} stars.`;
  setStatus(`Added ${sample.id} from ${sample.count} steady samples. ${readyText}`);
}

function clearAlignment() {
  state.alignmentSamples = [];
  state.calibration = null;
  refreshCalibrationState();
  setStatus("Alignment cleared. Use Align stars to collect 3-6 low-star samples.");
}

function refreshCalibrationState() {
  clearAlignButton.disabled = !state.calibration && state.alignmentSamples.length === 0;
  if (state.rawPointing) {
    state.pointing = calibratedPointing(state.rawPointing);
    renderPointing();
  }
  renderCatalogResults();
}

function averagedRawPointing(durationMs) {
  const samples = [];
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const timer = window.setInterval(() => {
      if (state.rawPointing) {
        samples.push({ ...state.rawPointing });
      }

      if (Date.now() - startedAt >= durationMs) {
        window.clearInterval(timer);
        const average = stablePointingAverage(samples);
        if (!average) {
          reject(new Error("Not enough stable sensor readings. Hold steadier and try again."));
          return;
        }
        resolve(average);
      }
    }, 80);
  });
}

function stablePointingAverage(samples) {
  const usable = samples.filter((sample) => (
    Number.isFinite(sample.azDeg)
    && Number.isFinite(sample.altDeg)
    && Date.now() - sample.timestamp < 4000
  ));

  if (usable.length < 8) return null;

  const firstPassAz = circularMeanDeg(usable.map((sample) => sample.azDeg));
  const firstPassAlt = median(usable.map((sample) => sample.altDeg));
  const stable = usable.filter((sample) => (
    Math.abs(signedDeltaDeg(sample.azDeg, firstPassAz)) <= 30
    && Math.abs(sample.altDeg - firstPassAlt) <= 10
  ));

  if (stable.length < Math.max(6, usable.length * 0.45)) return null;

  return {
    azDeg: circularMeanDeg(stable.map((sample) => sample.azDeg)),
    altDeg: stable.reduce((sum, sample) => sum + sample.altDeg, 0) / stable.length,
    count: stable.length,
  };
}

function circularMeanDeg(values) {
  let x = 0;
  let y = 0;

  for (const value of values) {
    x += Math.cos(value * DEG);
    y += Math.sin(value * DEG);
  }

  return normalizeDegrees(Math.atan2(y, x) * RAD);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calibratedPointing(rawPointing) {
  if (state.alignmentSamples.length >= ALIGNMENT_MIN_SAMPLES) {
    return multiStarCalibratedPointing(rawPointing);
  }

  if (!state.calibration) return { ...rawPointing };

  return {
    azDeg: normalizeDegrees(rawPointing.azDeg + state.calibration.azOffsetDeg),
    altDeg: clamp(rawPointing.altDeg + state.calibration.altOffsetDeg, -90, 90),
    timestamp: rawPointing.timestamp,
  };
}

function multiStarCalibratedPointing(rawPointing) {
  let totalWeight = 0;
  let azOffset = 0;
  let altOffset = 0;

  for (const sample of state.alignmentSamples) {
    const deltaAz = signedDeltaDeg(rawPointing.azDeg, sample.measuredAzDeg);
    const deltaAlt = rawPointing.altDeg - sample.measuredAltDeg;
    const distance = Math.hypot(deltaAz * Math.cos(rawPointing.altDeg * DEG), deltaAlt);
    const weight = 1 / Math.max(6, distance) ** 2;

    totalWeight += weight;
    azOffset += signedDeltaDeg(sample.trueAzDeg, sample.measuredAzDeg) * weight;
    altOffset += (sample.trueAltDeg - sample.measuredAltDeg) * weight;
  }

  return {
    azDeg: normalizeDegrees(rawPointing.azDeg + azOffset / totalWeight),
    altDeg: clamp(rawPointing.altDeg + altOffset / totalWeight, -90, 90),
    timestamp: rawPointing.timestamp,
  };
}

function updateGuide(date = new Date()) {
  if (!state.target) return;

  const target = currentCatalogObject(state.target, date);
  guideIndicator.classList.remove("hidden");
  guideTarget.textContent = alignmentLabel(target.id);

  if (!state.location || !state.pointing) {
    guideDirection.textContent = "Start sensors";
    guideIndicator.classList.remove("on-target");
    targetCheck.classList.add("hidden");
    return;
  }

  const targetAltAz = objectAltAz(target, date);

  const deltaAz = signedDeltaDeg(targetAltAz.azDeg, state.pointing.azDeg);
  const deltaAlt = targetAltAz.altDeg - state.pointing.altDeg;
  const azText = Math.abs(deltaAz) < 1 ? "" : `${deltaAz > 0 ? "RIGHT" : "LEFT"} ${Math.abs(deltaAz).toFixed(1)} deg`;
  const altText = Math.abs(deltaAlt) < 1 ? "" : `${deltaAlt > 0 ? "UP" : "DOWN"} ${Math.abs(deltaAlt).toFixed(1)} deg`;
  const resolvedImageHalfSize = state.fov / 2;
  const isInResolvedImage = Math.abs(deltaAz) <= resolvedImageHalfSize && Math.abs(deltaAlt) <= resolvedImageHalfSize;

  guideIndicator.classList.toggle("on-target", isInResolvedImage);
  targetCheck.classList.toggle("hidden", !isInResolvedImage);
  guideDirection.textContent = isInResolvedImage
    ? `ON TARGET | Alt ${targetAltAz.altDeg.toFixed(1)} deg, Az ${targetAltAz.azDeg.toFixed(1)} deg`
    : [azText, altText].filter(Boolean).join(" / ");
}

function objectAltAz(object, date) {
  if (object.catalog === "solar" && object.altAz) return object.altAz;

  return equatorialToHorizontal(
    object.ra,
    object.dec,
    state.location.lat,
    state.location.lon,
    date,
  );
}

function alignmentLabel(targetId) {
  if (state.alignmentSamples.length >= ALIGNMENT_MIN_SAMPLES) {
    return `${targetId} aligned ${state.alignmentSamples.length}`;
  }
  if (state.alignmentSamples.length > 0) {
    return `${targetId} align ${state.alignmentSamples.length}/${ALIGNMENT_MIN_SAMPLES}`;
  }
  return state.calibration ? `${targetId} calibrated` : targetId;
}

function searchText(object) {
  return [object.id, object.name, object.catalog, object.type, ...(object.aliases || [])]
    .join(" ")
    .toLowerCase();
}

function relevanceScore(object, query) {
  const id = object.id.toLowerCase();
  const name = object.name.toLowerCase();
  const aliases = (object.aliases || []).map((alias) => alias.toLowerCase());

  if (id === query || name === query) return 0;
  if (id.startsWith(query) || name.startsWith(query)) return 1;
  if (aliases.some((alias) => alias === query)) return 2;
  if (aliases.some((alias) => alias.startsWith(query))) return 3;
  return 4;
}

function matchesType(object, selectedType) {
  if (selectedType === "all") return true;
  const type = String(object.type || "").toLowerCase();
  const text = `${type} ${object.name || ""} ${object.id || ""}`.toLowerCase();

  if (selectedType === "galaxy") {
    return object.catalog !== "star"
      && (type === "g" || type.startsWith("gip") || type.startsWith("gx") || text.includes("gal") || text.includes("agn"));
  }
  if (selectedType === "nebula") {
    return type === "pn" || type === "pl" || text.includes("neb") || type.includes("nb") || text.includes("snr");
  }
  if (selectedType === "cluster") {
    return type === "oc" || type === "gb" || type.includes("cl") || text.includes("cluster");
  }
  if (selectedType === "star") {
    return object.catalog === "star" || text.includes("star") || text.includes("*");
  }
  if (selectedType === "solar-system") {
    return object.catalog === "solar";
  }

  return true;
}

function catalogLabel(value) {
  const labels = {
    ngc: "NGC",
    messier: "Messier",
    caldwell: "Caldwell",
    star: "Star",
    solar: "Solar System",
  };
  return labels[value] || value;
}

function typeLabel(value) {
  return value || "Object";
}

async function restartLiveCamera() {
  setStatus("Restoring live camera for the next target.");
  imageLink.href = "https://skyview.gsfc.nasa.gov/current/cgi/query.pl";
  imageLink.classList.add("disabled");
  calibrateButton.classList.toggle("hidden", !state.target);
  restartCameraButton.classList.add("hidden");
  state.lastResolvedKey = "";

  try {
    if (!state.stream || !state.stream.getVideoTracks().some((track) => track.readyState === "live")) {
      await startCamera();
    } else {
      camera.srcObject = state.stream;
      await camera.play();
    }
    setStatus("Live camera ready. Point at another target, then tap Resolve.");
  } catch (error) {
    restartCameraButton.classList.remove("hidden");
    setStatus(error.message || "Could not restart the live camera.");
  }
}

function skyViewUrl(raDeg, decDeg) {
  const params = new URLSearchParams({
    Position: `${raDeg.toFixed(6)},${decDeg.toFixed(6)}`,
    Survey: state.survey,
    Coordinates: "J2000",
    Projection: "Tan",
    Size: String(state.fov),
    Pixels: String(state.pixels),
    Scaling: "HistEq",
    Return: "JPEG",
  });

  return `${SKYVIEW_ENDPOINT}?${params.toString()}`;
}

function setResolvedImageLink(imageUrl) {
  imageLink.href = imageUrl;
  imageLink.classList.remove("disabled");
}

function openResolvedImage(event) {
  if (imageLink.classList.contains("disabled")) return;

  event.preventDefault();
  window.open(imageLink.href, "_blank", "noopener,noreferrer");
}

function horizontalToEquatorial(azDeg, altDeg, latDeg, lonDeg, date) {
  const az = azDeg * DEG;
  const alt = altDeg * DEG;
  const lat = latDeg * DEG;
  const lst = localSiderealTimeDeg(date, lonDeg) * DEG;

  const sinDec = Math.sin(alt) * Math.sin(lat)
    + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(clamp(sinDec, -1, 1));

  const hourAngle = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az),
  );

  const ra = normalizeRadians(lst - hourAngle);

  return {
    raDeg: ra * RAD,
    decDeg: dec * RAD,
  };
}

function equatorialToHorizontal(raDeg, decDeg, latDeg, lonDeg, date) {
  const lst = localSiderealTimeDeg(date, lonDeg);
  const hourAngle = signedDeltaDeg(lst, raDeg) * DEG;
  const dec = decDeg * DEG;
  const lat = latDeg * DEG;

  const sinAlt = Math.sin(dec) * Math.sin(lat)
    + Math.cos(dec) * Math.cos(lat) * Math.cos(hourAngle);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const az = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle),
  );

  return {
    azDeg: normalizeDegrees(az * RAD),
    altDeg: alt * RAD,
  };
}

function localSiderealTimeDeg(date, lonDeg) {
  const jd = julianDate(date);
  const centuries = (jd - 2451545.0) / 36525;
  const gmst = 280.46061837
    + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * centuries * centuries
    - (centuries * centuries * centuries) / 38710000;

  return normalizeDegrees(gmst + lonDeg);
}

function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function formatRa(raDeg) {
  const totalHours = normalizeDegrees(raDeg) / 15;
  const hours = Math.floor(totalHours);
  const minutesFloat = (totalHours - hours) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);

  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function formatDec(decDeg) {
  const sign = decDeg < 0 ? "-" : "+";
  const totalArcSeconds = Math.round(Math.abs(decDeg) * 3600);
  const degrees = Math.floor(totalArcSeconds / 3600);
  const minutes = Math.floor((totalArcSeconds % 3600) / 60);
  const seconds = totalArcSeconds % 60;

  return `${sign}${degrees}° ${String(minutes).padStart(2, "0")}' ${String(seconds).padStart(2, "0")}"`;
}

function formatUtc(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatCoords(latDeg, lonDeg) {
  const latSuffix = latDeg >= 0 ? "N" : "S";
  const lonSuffix = lonDeg >= 0 ? "E" : "W";
  return `${Math.abs(latDeg).toFixed(5)} ${latSuffix}, ${Math.abs(lonDeg).toFixed(5)} ${lonSuffix}`;
}

function formatSolarDistance(object) {
  if (!Number.isFinite(object.distanceAu)) return "";

  if (object.id === "Moon") {
    return `${Math.round(object.distanceAu * 149597870.7).toLocaleString()} km`;
  }

  return `${object.distanceAu.toFixed(3)} AU`;
}

function signedDeltaDeg(toDeg, fromDeg) {
  const delta = normalizeDegrees(toDeg - fromDeg);
  return delta > 180 ? delta - 360 : delta;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeRadians(value) {
  const fullTurn = Math.PI * 2;
  return ((value % fullTurn) + fullTurn) % fullTurn;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
