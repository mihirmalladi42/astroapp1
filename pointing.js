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

    // iPhone browsers supply the real-world magnetic heading separately because
    // alpha angle is not guaranteed to use an Earth-fixed reference frame.
    if (Number.isFinite(event.webkitCompassHeading)) {
      magneticAzDeg = normalizeDegrees(event.webkitCompassHeading);
      // Keep the iPhone browser's field-tested continuous pitch mapping. Its gamma value
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

  // At steep camera angles an orientation source can report the same physical
  // direction on the opposite side of the compass. Choose between the reported
  // azimuth and its exact 180-degree equivalent using the last stable direction.
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

  // Google and other iPhone browsers can switch to an opposite compass
  // representation near a steep pitch. That switch is not always exactly 180
  // degrees, so learn the actual offset on each opposite-branch entry.
  function unwrapCompassAzimuth(sample, previous, options = {}) {
    const {
      minTransitionAltitudeDeg = 35,
      maxTransitionAltitudeDeg = 55,
      normalBranchMaxAltitudeDeg = 45,
      branchJumpMinDeg = 120,
      maxAltitudeStepDeg = 8,
      maxGapMs = 1000,
    } = options;
    const normalizedRawAzDeg = normalizeDegrees(sample.rawAzDeg);
    const altDeg = sample.altDeg;
    const timestamp = sample.timestamp;
    const initial = {
      rawAzDeg: normalizedRawAzDeg,
      azDeg: normalizedRawAzDeg,
      altDeg,
      timestamp,
      flipped: false,
      flippedOffsetDeg: 0,
      branchChanged: false,
    };

    if (
      !previous
      || !Number.isFinite(previous.rawAzDeg)
      || !Number.isFinite(previous.azDeg)
      || !Number.isFinite(previous.altDeg)
      || !Number.isFinite(previous.timestamp)
      || !Number.isFinite(timestamp)
    ) {
      return initial;
    }

    const rawDeltaDeg = signedDeltaDeg(normalizedRawAzDeg, previous.rawAzDeg);
    const altitudeStepDeg = Math.abs(altDeg - previous.altDeg);
    const elapsedMs = timestamp - previous.timestamp;
    const inTransitionBand = (value) => {
      const absoluteAltitudeDeg = Math.abs(value);
      return absoluteAltitudeDeg >= minTransitionAltitudeDeg
        && absoluteAltitudeDeg <= maxTransitionAltitudeDeg;
    };
    const nearTransition = inTransitionBand(altDeg)
      || inTransitionBand(previous.altDeg);
    let branchChanged = nearTransition
      && elapsedMs >= 0
      && elapsedMs <= maxGapMs
      && Math.abs(rawDeltaDeg) >= branchJumpMinDeg
      && altitudeStepDeg <= maxAltitudeStepDeg;
    let flipped = Boolean(previous.flipped);
    let flippedOffsetDeg = Number.isFinite(previous.flippedOffsetDeg)
      ? previous.flippedOffsetDeg
      : 0;

    if (branchChanged) {
      flipped = !flipped;
      if (flipped) {
        flippedOffsetDeg = signedDeltaDeg(previous.azDeg, normalizedRawAzDeg);
      }
    } else if (
      flipped
      && Math.abs(altDeg) <= normalBranchMaxAltitudeDeg
      && Math.abs(rawDeltaDeg) >= branchJumpMinDeg
    ) {
      // A suspended page can miss the event that returns to the authoritative
      // normal branch. The altitude side plus the large raw jump identifies it.
      flipped = false;
      branchChanged = true;
    } else if (flipped && Math.abs(altDeg) < minTransitionAltitudeDeg) {
      // Recover safely if the browser resumed below the transition after the
      // opposite-branch event was missed while the page was suspended.
      flipped = false;
      branchChanged = true;
    }

    return {
      rawAzDeg: normalizedRawAzDeg,
      azDeg: flipped
        ? normalizeDegrees(normalizedRawAzDeg + flippedOffsetDeg)
        : normalizedRawAzDeg,
      altDeg,
      timestamp,
      flipped,
      flippedOffsetDeg,
      branchChanged,
    };
  }

  function filterCompassSpike(sample, previous, pending, options = {}) {
    const {
      minAltitudeDeg = 35,
      spikeMinDeg = 55,
      maxAltitudeStepDeg = 8,
      maxGapMs = 1000,
      confirmationToleranceDeg = 12,
    } = options;
    const normalizedAzDeg = normalizeDegrees(sample.azDeg);
    const passthrough = {
      azDeg: normalizedAzDeg,
      pending: null,
      rejected: false,
      confirmed: false,
    };

    if (
      !previous
      || !Number.isFinite(previous.azDeg)
      || !Number.isFinite(previous.altDeg)
      || !Number.isFinite(previous.timestamp)
      || !Number.isFinite(sample.altDeg)
      || !Number.isFinite(sample.timestamp)
    ) {
      return passthrough;
    }

    const elapsedMs = sample.timestamp - previous.timestamp;
    const looksLikeSpike = Math.abs(sample.altDeg) >= minAltitudeDeg
      && elapsedMs >= 0
      && elapsedMs <= maxGapMs
      && Math.abs(signedDeltaDeg(normalizedAzDeg, previous.azDeg)) >= spikeMinDeg
      && Math.abs(sample.altDeg - previous.altDeg) < maxAltitudeStepDeg;
    if (!looksLikeSpike) return passthrough;

    const pendingAgeMs = pending
      ? sample.timestamp - pending.timestamp
      : Number.POSITIVE_INFINITY;
    const confirmsPending = pending
      && pendingAgeMs >= 0
      && pendingAgeMs <= maxGapMs
      && Math.abs(signedDeltaDeg(normalizedAzDeg, pending.azDeg)) <= confirmationToleranceDeg;
    if (confirmsPending) {
      return {
        ...passthrough,
        confirmed: true,
      };
    }

    return {
      azDeg: normalizeDegrees(previous.azDeg),
      pending: {
        azDeg: normalizedAzDeg,
        timestamp: sample.timestamp,
      },
      rejected: true,
      confirmed: false,
    };
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
    unwrapCompassAzimuth,
    filterCompassSpike,
    normalizeDegrees,
  };
}));
