# Sky Lens

A small mobile-first web app that opens the rear camera, estimates the camera center's Alt/Az from phone sensors, converts that point to RA/Dec using UTC time and geolocation, and creates a NASA SkyView image link for that position.

## Run

```sh
python3 -m http.server 5173
```

Open `http://localhost:5173` for a desktop preview.

For real phone testing, serve the folder over HTTPS. Mobile browsers generally require a secure context for camera, geolocation, and orientation permissions unless the page is on `localhost`.

## Notes

The RA/Dec conversion is deterministic astronomy math. Magnetic headings are corrected to true north locally with WMM2025. The remaining limiting factor is phone orientation accuracy, especially compass calibration and how each browser reports camera tilt.

The vendored geomagnetism browser bundle is derived from `@cristianob/geomagnetism` 0.2.0 under the Apache License 2.0. Its license is included at `vendor/geomagnetism.LICENSE.txt`.
