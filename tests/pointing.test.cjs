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

test("iPhone pointing does not require Safari's unused gamma value", () => {
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
