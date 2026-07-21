(function initSkyLensPointing(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.SkyLensPointing = api;
}(typeof globalThis === "object" ? globalThis : window, () => {
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  function magneticDeclinationDeg(geomagnetism, latDeg, lonDeg, date = new Date()) {
    if (!geomagnetism || typeof geomagnetism.model !== "function") {
      throw new Error("The magnetic field model did not load.");
    }

    const result = geomagnetism.model(date).point([latDeg, lonDeg, 0]);
    if (!Number.isFinite(result?.decl)) {
      throw new Error("The magnetic field model could not calculate true north.");
    }

    return result.decl;
  }

  function readRearCameraPointing(event, declinationDeg) {
    const betaDeg = event?.beta;
    const gammaDeg = event?.gamma;

    if (!Number.isFinite(betaDeg)) {
      return { valid: false, reason: "orientation-unavailable" };
    }

    if (!Number.isFinite(declinationDeg)) {
      return { valid: false, reason: "true-north-unavailable" };
    }

    const compassAccuracyDeg = Number.isFinite(event.webkitCompassAccuracy)
      ? event.webkitCompassAccuracy
      : null;

    if (compassAccuracyDeg !== null && compassAccuracyDeg < 0) {
      return {
        valid: false,
        reason: "compass-uncalibrated",
        compassAccuracyDeg,
      };
    }

    let magneticAzDeg;
    let altDeg;
    let source;

    // Safari supplies the real-world magnetic heading separately because its
    // alpha angle is not guaranteed to use an Earth-fixed reference frame.
    if (Number.isFinite(event.webkitCompassHeading)) {
      magneticAzDeg = normalizeDegrees(event.webkitCompassHeading);
      // Keep Safari's field-tested continuous pitch mapping. Its gamma value
      // jitters near the horizon and previously made altitude reverse while
      // the phone was moving upward.
      altDeg = safariRearCameraAltitudeDeg(betaDeg);
      source = "webkit";
    } else if (event.absolute && Number.isFinite(event.alpha)) {
      if (!Number.isFinite(gammaDeg)) {
        return { valid: false, reason: "orientation-unavailable" };
      }

      const vector = rearCameraVector(event.alpha, betaDeg, gammaDeg);
      const horizontalLength = Math.hypot(vector.east, vector.north);

      if (horizontalLength < 1e-8) {
        return { valid: false, reason: "camera-vertical" };
      }

      magneticAzDeg = normalizeDegrees(Math.atan2(vector.east, vector.north) * RAD);
      altDeg = Math.asin(clamp(vector.up, -1, 1)) * RAD;
      source = "absolute-alpha";
    } else {
      return { valid: false, reason: "compass-unavailable" };
    }

    return {
      valid: true,
      source,
      magneticAzDeg,
      declinationDeg,
      azDeg: normalizeDegrees(magneticAzDeg + declinationDeg),
      altDeg,
      compassAccuracyDeg,
    };
  }

  function safariRearCameraAltitudeDeg(betaDeg) {
    return betaDeg >= 0
      ? betaDeg - 90
      : betaDeg + 90;
  }

  function rearCameraAltitudeDeg(betaDeg, gammaDeg) {
    const beta = betaDeg * DEG;
    const gamma = gammaDeg * DEG;
    const up = -Math.cos(beta) * Math.cos(gamma);
    return Math.asin(clamp(up, -1, 1)) * RAD;
  }

  // W3C Device Orientation uses intrinsic Z-X'-Y'' rotations. Applying that
  // rotation to the rear-camera axis [0, 0, -1] gives this Earth-frame vector.
  function rearCameraVector(alphaDeg, betaDeg, gammaDeg) {
    const alpha = alphaDeg * DEG;
    const beta = betaDeg * DEG;
    const gamma = gammaDeg * DEG;
    const sinAlpha = Math.sin(alpha);
    const cosAlpha = Math.cos(alpha);
    const sinBeta = Math.sin(beta);
    const cosBeta = Math.cos(beta);
    const sinGamma = Math.sin(gamma);
    const cosGamma = Math.cos(gamma);

    return {
      east: -cosAlpha * sinGamma - sinAlpha * sinBeta * cosGamma,
      north: -sinAlpha * sinGamma + cosAlpha * sinBeta * cosGamma,
      up: -cosBeta * cosGamma,
    };
  }

  // At steep camera angles Safari can report the same physical direction on
  // the opposite side of the compass. Choose between the reported azimuth and
  // its exact 180-degree equivalent using the last stable camera direction.
  function nearestEquivalentAzimuth(azDeg, referenceAzDeg) {
    const reportedAzDeg = normalizeDegrees(azDeg);
    const flippedAzDeg = normalizeDegrees(azDeg + 180);
    const reportedDistance = Math.abs(signedDeltaDeg(reportedAzDeg, referenceAzDeg));
    const flippedDistance = Math.abs(signedDeltaDeg(flippedAzDeg, referenceAzDeg));

    return flippedDistance < reportedDistance
      ? flippedAzDeg
      : reportedAzDeg;
  }

  function stabilizeHighAltitudeAzimuth(azDeg, altDeg, referenceAzDeg, minAltitudeDeg) {
    if (Math.abs(altDeg) < minAltitudeDeg) {
      return normalizeDegrees(azDeg);
    }

    return nearestEquivalentAzimuth(azDeg, referenceAzDeg);
  }

  function signedDeltaDeg(toDeg, fromDeg) {
    const delta = normalizeDegrees(toDeg - fromDeg);
    return delta > 180 ? delta - 360 : delta;
  }

  function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  return {
    magneticDeclinationDeg,
    readRearCameraPointing,
    rearCameraAltitudeDeg,
    rearCameraVector,
    safariRearCameraAltitudeDeg,
    nearestEquivalentAzimuth,
    stabilizeHighAltitudeAzimuth,
    normalizeDegrees,
  };
}));
