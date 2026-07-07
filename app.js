const state = {
  stream: null,
  location: null,
  pointing: null,
  lastResolvedAt: 0,
  lastResolvedKey: "",
  overlayVisible: true,
  running: false,
};

const camera = document.querySelector("#camera");
const skyImage = document.querySelector("#skyImage");
const startButton = document.querySelector("#startButton");
const resolveButton = document.querySelector("#resolveButton");
const toggleOverlayButton = document.querySelector("#toggleOverlayButton");
const statusEl = document.querySelector("#status");
const azimuthValue = document.querySelector("#azimuthValue");
const altitudeValue = document.querySelector("#altitudeValue");
const raValue = document.querySelector("#raValue");
const decValue = document.querySelector("#decValue");

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

startButton.addEventListener("click", startExperience);
resolveButton.addEventListener("click", () => resolveSky(true));
toggleOverlayButton.addEventListener("click", toggleOverlay);

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
    toggleOverlayButton.disabled = false;
    startButton.textContent = "Running";
    setStatus("Point at the sky. The overlay updates from the camera center.");
    tick();
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

  return sign * (forwardTilt - rollPenalty);
}

function renderPointing() {
  const pointing = state.pointing;
  if (!pointing || !state.location) return;

  const equatorial = horizontalToEquatorial(
    pointing.azDeg,
    pointing.altDeg,
    state.location.lat,
    state.location.lon,
    new Date(),
  );

  azimuthValue.textContent = `${pointing.azDeg.toFixed(1)} deg`;
  altitudeValue.textContent = `${pointing.altDeg.toFixed(1)} deg`;
  raValue.textContent = formatRa(equatorial.raDeg);
  decValue.textContent = `${equatorial.decDeg.toFixed(2)} deg`;
}

function tick() {
  if (!state.running) return;
  resolveSky(false);
  window.setTimeout(tick, 1600);
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
  const canAutoRefresh = Date.now() - state.lastResolvedAt > 4500;

  if (!force && (!canAutoRefresh || key === state.lastResolvedKey)) return;

  const url = legacySurveyUrl(equatorial.raDeg, equatorial.decDeg);
  state.lastResolvedAt = Date.now();
  state.lastResolvedKey = key;
  skyImage.src = url;
  skyImage.classList.toggle("visible", state.overlayVisible);
  setStatus(`Resolved center at RA ${formatRa(equatorial.raDeg)}, Dec ${equatorial.decDeg.toFixed(2)} deg.`);
}

function legacySurveyUrl(raDeg, decDeg) {
  const params = new URLSearchParams({
    ra: raDeg.toFixed(6),
    dec: decDeg.toFixed(6),
    layer: "ls-dr10",
    pixscale: "1.5",
    size: "720",
  });

  return `https://www.legacysurvey.org/viewer/jpeg-cutout?${params.toString()}`;
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

function toggleOverlay() {
  state.overlayVisible = !state.overlayVisible;
  skyImage.classList.toggle("visible", state.overlayVisible && Boolean(skyImage.src));
  toggleOverlayButton.textContent = state.overlayVisible ? "Hide overlay" : "Show overlay";
}

function formatRa(raDeg) {
  const totalHours = normalizeDegrees(raDeg) / 15;
  const hours = Math.floor(totalHours);
  const minutesFloat = (totalHours - hours) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);

  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
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
