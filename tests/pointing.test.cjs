const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pointing = require("../pointing.js");

function loadGeomagnetismBundle() {
  const bundlePath = path.join(__dirname, "../vendor/geomagnetism.browser.min.js");
  const context = { console, Date, Math };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(bundlePath, "utf8"), context);
  return context.Geomagnetism;
}

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const COMPASS_UNWRAP_OPTIONS = {
  minTransitionAltitudeDeg: 35,
  maxTransitionAltitudeDeg: 55,
  normalBranchMaxAltitudeDeg: 45,
  branchJumpMinDeg: 120,
  maxAltitudeStepDeg: 8,
  maxGapMs: 1000,
};

const COMPASS_SPIKE_OPTIONS = {
  minAltitudeDeg: 35,
  spikeMinDeg: 55,
  maxAltitudeStepDeg: 8,
  maxGapMs: 1000,
  confirmationToleranceDeg: 12,
};

function unwrapSample(rawAzDeg, altDeg, timestamp, previous = null) {
  return pointing.unwrapCompassAzimuth(
    { rawAzDeg, altDeg, timestamp },
    previous,
    COMPASS_UNWRAP_OPTIONS,
  );
}

test("WMM2025 reproduces NOAA declination for the Deneb report", () => {
  const geomagnetism = loadGeomagnetismBundle();
  const declination = pointing.magneticDeclinationDeg(
    geomagnetism,
    34.10375,
    -84.18003,
    new Date("2026-07-12T01:31:00Z"),
  );

  closeTo(declination, -5.78221, 0.0001);
});

test("WMM2025 matches the official NOAA global test values", () => {
  const geomagnetism = loadGeomagnetismBundle();
  const rows = [
    ["2025-01-01T00:00:00Z", 0, 80, 0, 1.28],
    ["2025-01-01T00:00:00Z", 0, 0, 120, -0.16],
    ["2025-01-01T00:00:00Z", 0, -80, 240, 68.78],
    ["2025-01-01T00:00:00Z", 100, 80, 0, 0.85],
    ["2025-01-01T00:00:00Z", 100, 0, 120, -0.15],
    ["2025-01-01T00:00:00Z", 100, -80, 240, 68.21],
    ["2027-07-02T12:00:00Z", 0, 80, 0, 2.59],
    ["2027-07-02T12:00:00Z", 0, 0, 120, -0.24],
    ["2027-07-02T12:00:00Z", 0, -80, 240, 68.49],
    ["2027-07-02T12:00:00Z", 100, 80, 0, 2.16],
    ["2027-07-02T12:00:00Z", 100, 0, 120, -0.23],
    ["2027-07-02T12:00:00Z", 100, -80, 240, 67.93],
  ];

  for (const [isoDate, altitudeKm, latDeg, lonDeg, expectedDeclination] of rows) {
    const result = geomagnetism
      .model(new Date(isoDate))
      .point([latDeg, lonDeg, altitudeKm]);
    closeTo(result.decl, expectedDeclination, 0.01);
  }
});

test("iPhone magnetic heading is corrected to true azimuth", () => {
  const result = pointing.readRearCameraPointing({
    beta: 118.77,
    gamma: 0,
    webkitCompassHeading: 52.9,
    webkitCompassAccuracy: 2,
  }, -5.78221);

  assert.equal(result.valid, true);
  assert.equal(result.source, "webkit");
  closeTo(result.azDeg, 47.11779);
  closeTo(result.altDeg, 28.77);
});

test("Deneb screenshot now guides right by the observed offset", () => {
  const targetAzDeg = 52.6140925;
  const declinationDeg = -5.78221;
  const observed = pointing.readRearCameraPointing({
    beta: 118.6,
    gamma: 0,
    webkitCompassHeading: 52.9,
  }, declinationDeg);
  const correctedDelta = pointing.normalizeDegrees(targetAzDeg - observed.azDeg);
  const expectedCenteredMagneticHeading = pointing.normalizeDegrees(targetAzDeg - declinationDeg);

  closeTo(correctedDelta, 5.4963025);
  closeTo(expectedCenteredMagneticHeading, 58.3963025);
});

test("true-north correction wraps cleanly through north", () => {
  const result = pointing.readRearCameraPointing({
    beta: 90,
    gamma: 0,
    webkitCompassHeading: 3,
  }, -5.78221);

  closeTo(result.azDeg, 357.21779);
});

test("absolute alpha, beta, and gamma point the rear camera axis", () => {
  const result = pointing.readRearCameraPointing({
    absolute: true,
    alpha: 300,
    beta: 90,
    gamma: 10,
  }, 0);

  assert.equal(result.valid, true);
  closeTo(result.azDeg, 50);
  closeTo(result.altDeg, 0);
});

test("camera altitude includes device roll", () => {
  const noRoll = pointing.rearCameraAltitudeDeg(120, 0);
  const rolled = pointing.rearCameraAltitudeDeg(120, 30);

  closeTo(noRoll, 30);
  closeTo(rolled, Math.asin(Math.sqrt(3) / 4) * 180 / Math.PI);
  assert.ok(rolled < noRoll);
});

test("iPhone keeps the stable beta-only altitude mapping", () => {
  closeTo(pointing.safariRearCameraAltitudeDeg(118.77), 28.77);
  closeTo(pointing.safariRearCameraAltitudeDeg(-61.23), 28.77);
});

test("an explicitly uncalibrated iPhone compass is rejected", () => {
  const result = pointing.readRearCameraPointing({
    beta: 118,
    gamma: 0,
    webkitCompassHeading: 52,
    webkitCompassAccuracy: -1,
  }, -5.8);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "compass-uncalibrated");
});

test("iPhone pointing does not require the browser's unused gamma value", () => {
  const result = pointing.readRearCameraPointing({
    beta: 118,
    gamma: null,
    webkitCompassHeading: 58,
  }, -5.8);

  assert.equal(result.valid, true);
  closeTo(result.azDeg, 52.2);
  closeTo(result.altDeg, 28);
});

test("high-altitude West-to-East representation flip stays West", () => {
  closeTo(pointing.stabilizeHighAltitudeAzimuth(90, 45, 270, 35), 270);
});

test("high-altitude 330-to-150 representation flip stays at 330", () => {
  closeTo(pointing.stabilizeHighAltitudeAzimuth(150, 45, 330, 35), 330);
});

test("ordinary azimuth movement is not flipped", () => {
  closeTo(pointing.nearestEquivalentAzimuth(275, 270), 275);
});

test("180-degree correction remains continuous across North", () => {
  closeTo(pointing.nearestEquivalentAzimuth(181, 359), 1);
});

test("low-altitude azimuth is left untouched", () => {
  closeTo(pointing.stabilizeHighAltitudeAzimuth(90, 20, 270, 35), 90);
});

test("measured 172-degree browser branch switch stays continuous", () => {
  let sample = unwrapSample(138.8, 44.7, 1000);
  sample = unwrapSample(311.0, 45.3, 1020, sample);

  assert.equal(sample.branchChanged, true);
  assert.equal(sample.flipped, true);
  closeTo(sample.azDeg, 138.8);
});

test("measured 184-degree browser branch switch stays continuous", () => {
  let sample = unwrapSample(90.4, 43.2, 1000);
  sample = unwrapSample(274.3, 45.5, 1020, sample);

  assert.equal(sample.branchChanged, true);
  assert.equal(sample.flipped, true);
  closeTo(sample.azDeg, 90.4);
});

test("ordinary movement continues while the opposite branch is active", () => {
  let sample = unwrapSample(138.8, 44.7, 1000);
  sample = unwrapSample(311.0, 45.3, 1020, sample);
  sample = unwrapSample(312.5, 46.0, 1040, sample);

  assert.equal(sample.branchChanged, false);
  assert.equal(sample.flipped, true);
  closeTo(sample.azDeg, 140.3);
});

test("each flipped-branch entry is relearned from the absolute branch", () => {
  let sample = unwrapSample(138.8, 44.7, 1000);
  sample = unwrapSample(311.0, 45.3, 1020, sample);
  const beforeReverseCrossing = sample.azDeg;
  sample = unwrapSample(137.4, 45.0, 1040, sample);

  assert.equal(sample.branchChanged, true);
  assert.equal(sample.flipped, false);
  closeTo(sample.azDeg, 137.4);
  assert.ok(Math.abs(sample.azDeg - beforeReverseCrossing) < 2);

  const beforeNextCrossing = sample.azDeg;
  sample = unwrapSample(310.8, 45.4, 1060, sample);
  assert.equal(sample.branchChanged, true);
  assert.equal(sample.flipped, true);
  closeTo(sample.azDeg, beforeNextCrossing);
});

test("normal six-degree yaw is preserved", () => {
  let sample = unwrapSample(130, 46, 1000);
  sample = unwrapSample(136, 46.5, 1020, sample);

  assert.equal(sample.branchChanged, false);
  closeTo(sample.azDeg, 136);
});

test("learned branch correction wraps continuously through North", () => {
  let sample = unwrapSample(359, 44.8, 1000);
  sample = unwrapSample(171, 45.3, 1020, sample);

  assert.equal(sample.branchChanged, true);
  assert.equal(sample.flipped, true);
  closeTo(sample.azDeg, 359);
});

test("a missed reverse event reanchors to the absolute branch", () => {
  let sample = unwrapSample(138.8, 44.7, 1000);
  sample = unwrapSample(311, 45.3, 1020, sample);
  const beforeRecovery = sample.azDeg;
  sample = unwrapSample(137, 34, 2500, sample);

  assert.equal(sample.flipped, false);
  assert.equal(sample.branchChanged, true);
  closeTo(sample.azDeg, 137);
  assert.ok(Math.abs(sample.azDeg - beforeRecovery) < 2);

  sample = unwrapSample(136, 33, 2520, sample);
  closeTo(sample.azDeg, 136);
});

test("a missed reverse event reanchors near 45 degrees after a pause", () => {
  let sample = unwrapSample(138.8, 44.7, 1000);
  sample = unwrapSample(311, 45.3, 1020, sample);
  sample = unwrapSample(137, 44.5, 2500, sample);

  assert.equal(sample.flipped, false);
  assert.equal(sample.branchChanged, true);
  closeTo(sample.azDeg, 137);
});

test("a large turn outside the 45-degree transition is not unwrapped", () => {
  let sample = unwrapSample(10, 60, 1000);
  sample = unwrapSample(150, 60, 1020, sample);

  assert.equal(sample.branchChanged, false);
  closeTo(sample.azDeg, 150);
});

test("a large turn after a sensor pause is not unwrapped", () => {
  let sample = unwrapSample(10, 45, 1000);
  sample = unwrapSample(150, 45, 2500, sample);

  assert.equal(sample.branchChanged, false);
  closeTo(sample.azDeg, 150);
});

test("a persistent large heading change is accepted on confirmation", () => {
  const previous = { azDeg: 10, altDeg: 60, timestamp: 1000 };
  const first = pointing.filterCompassSpike(
    { azDeg: 150, altDeg: 60, timestamp: 1020 },
    previous,
    null,
    COMPASS_SPIKE_OPTIONS,
  );

  assert.equal(first.rejected, true);
  closeTo(first.azDeg, 10);

  const second = pointing.filterCompassSpike(
    { azDeg: 151, altDeg: 60, timestamp: 1040 },
    { azDeg: first.azDeg, altDeg: 60, timestamp: 1020 },
    first.pending,
    COMPASS_SPIKE_OPTIONS,
  );
  assert.equal(second.rejected, false);
  assert.equal(second.confirmed, true);
  closeTo(second.azDeg, 151);
});

test("a one-sample compass spike is rejected without latching", () => {
  const previous = { azDeg: 10, altDeg: 60, timestamp: 1000 };
  const first = pointing.filterCompassSpike(
    { azDeg: 150, altDeg: 60, timestamp: 1020 },
    previous,
    null,
    COMPASS_SPIKE_OPTIONS,
  );
  const recovered = pointing.filterCompassSpike(
    { azDeg: 11, altDeg: 60, timestamp: 1040 },
    { azDeg: first.azDeg, altDeg: 60, timestamp: 1020 },
    first.pending,
    COMPASS_SPIKE_OPTIONS,
  );

  assert.equal(first.rejected, true);
  assert.equal(recovered.rejected, false);
  assert.equal(recovered.pending, null);
  closeTo(recovered.azDeg, 11);
});
