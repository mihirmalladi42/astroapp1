const SKYVIEW_ENDPOINT = "https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl";

const state = {
  stream: null,
  location: null,
  pointing: null,
  lastResolvedAt: 0,
  lastResolvedKey: "",
  running: false,
  survey: "DSS2 Red",
  fov: 2,
  pixels: 768,
  target: null,
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
const catalogCount = document.querySelector("#catalogCount");
const catalogResults = document.querySelector("#catalogResults");
const guideIndicator = document.querySelector("#guideIndicator");
const guideTarget = document.querySelector("#guideTarget");
const guideDirection = document.querySelector("#guideDirection");
const targetCheck = document.querySelector("#targetCheck");
const resolveButton = document.querySelector("#resolveButton");
const imageLink = document.querySelector("#imageLink");
const downloadLink = document.querySelector("#downloadLink");
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

startButton.addEventListener("click", startExperience);
catalogButton.addEventListener("click", toggleCatalogPanel);
catalogSearch.addEventListener("input", renderCatalogResults);
catalogFilter.addEventListener("change", renderCatalogResults);
typeFilter.addEventListener("change", renderCatalogResults);
resolveButton.addEventListener("click", () => resolveSky(true));
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
        state.location = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        resolve();
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
  const azDeg = getCompassHeading(event);
  const altDeg = getCameraAltitude(event);

  if (!Number.isFinite(azDeg) || !Number.isFinite(altDeg)) {
    setStatus("Move the phone in a figure eight if the compass is not ready.");
    return;
  }

  state.pointing = {
    azDeg: normalizeDegrees(azDeg),
    altDeg: clamp(altDeg, -90, 90),
    timestamp: Date.now(),
  };

  renderPointing();
}

function getCompassHeading(event) {
  if (Number.isFinite(event.webkitCompassHeading)) {
    return event.webkitCompassHeading;
  }

  if (event.absolute && Number.isFinite(event.alpha)) {
    return 360 - event.alpha;
  }

  if (Number.isFinite(event.alpha)) {
    return 360 - event.alpha;
  }

  return NaN;
}

function getCameraAltitude(event) {
  const beta = Number.isFinite(event.beta) ? event.beta : 0;
  const gamma = Number.isFinite(event.gamma) ? event.gamma : 0;

  // This uses the rear camera as the pointing axis. It is intentionally simple:
  // beta controls the main tilt, while gamma slightly reduces altitude when the
  // phone is rolled sideways.
  const forwardTilt = 90 - Math.abs(beta);
  const rollPenalty = Math.abs(gamma) * 0.35;
  const sign = beta >= 0 ? 1 : -1;

  return -sign * (forwardTilt - rollPenalty);
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

function renderCatalogResults() {
  if (!catalog.objects.length) {
    catalogCount.textContent = "Catalog did not load.";
    catalogResults.innerHTML = "";
    return;
  }

  const query = catalogSearch.value.trim().toLowerCase();
  const selectedCatalog = catalogFilter.value;
  const selectedType = typeFilter.value;
  const matches = [];

  for (const object of catalog.objects) {
    if (selectedCatalog !== "all" && object.catalog !== selectedCatalog) continue;
    if (!matchesType(object, selectedType)) continue;
    if (query && !searchText(object).includes(query)) continue;
    matches.push(object);
  }

  if (query) {
    matches.sort((a, b) => relevanceScore(a, query) - relevanceScore(b, query));
  }

  const visibleMatches = matches.slice(0, MAX_RESULTS);

  const totalText = catalog.counts.total ? `${catalog.counts.total.toLocaleString()} objects` : "catalog";
  catalogCount.textContent = `${visibleMatches.length.toLocaleString()} shown from ${matches.length.toLocaleString()} matches in ${totalText}`;
  catalogResults.innerHTML = "";

  for (const object of visibleMatches) {
    const row = document.createElement("div");
    row.className = "catalog-result";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    title.textContent = object.name === object.id ? object.id : `${object.id} - ${object.name}`;
    meta.textContent = `${catalogLabel(object.catalog)} | ${typeLabel(object.type)} | RA ${object.ra.toFixed(4)} deg, Dec ${object.dec.toFixed(4)} deg`;
    details.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Guide";
    button.addEventListener("click", () => resolveCatalogObject(object));

    row.append(details, button);
    catalogResults.append(row);
  }

  if (visibleMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "catalog-count";
    empty.textContent = "No matches.";
    catalogResults.append(empty);
  }
}

function resolveCatalogObject(object) {
  const url = skyViewUrl(object.ra, object.dec);
  state.target = object;
  state.lastResolvedAt = Date.now();
  state.lastResolvedKey = `catalog:${object.id}`;
  skyImage.removeAttribute("src");
  skyImage.classList.remove("visible");
  setResolvedImageLink(url);
  restartCameraButton.classList.remove("hidden");
  raValue.textContent = formatRa(object.ra);
  decValue.textContent = formatDec(object.dec);
  catalogPanel.classList.add("hidden");
  updateGuide(new Date());
  setStatus(`Catalog target ready: ${object.id} at RA ${formatRa(object.ra)}, Dec ${formatDec(object.dec)}.`);
}

function updateGuide(date = new Date()) {
  if (!state.target) return;

  guideIndicator.classList.remove("hidden");
  guideTarget.textContent = state.target.id;

  if (!state.location || !state.pointing) {
    guideDirection.textContent = "Start sensors";
    guideIndicator.classList.remove("on-target");
    targetCheck.classList.add("hidden");
    return;
  }

  const targetAltAz = equatorialToHorizontal(
    state.target.ra,
    state.target.dec,
    state.location.lat,
    state.location.lon,
    date,
  );

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

  return true;
}

function catalogLabel(value) {
  const labels = {
    ngc: "NGC",
    messier: "Messier",
    caldwell: "Caldwell",
    star: "Star",
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
  downloadLink.href = "https://skyview.gsfc.nasa.gov/current/cgi/query.pl";
  downloadLink.removeAttribute("download");
  downloadLink.classList.add("disabled");
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
    Scaling: "Log",
    Return: "JPEG",
  });

  return `${SKYVIEW_ENDPOINT}?${params.toString()}`;
}

function setResolvedImageLink(imageUrl) {
  imageLink.href = imageUrl;
  imageLink.classList.remove("disabled");
  downloadLink.href = imageUrl;
  downloadLink.download = "resolved-sky-image.jpg";
  downloadLink.classList.remove("disabled");
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
