# Sky Lens

A small mobile-first web app that opens the rear camera, estimates the camera center's Alt/Az from phone sensors, converts that point to RA/Dec using UTC time and geolocation, and overlays a no-key Legacy Survey JPEG cutout on top of the live feed.

## Run

```sh
python3 -m http.server 5173
```

Open `http://localhost:5173` for a desktop preview.

For real phone testing, serve the folder over HTTPS. Mobile browsers generally require a secure context for camera, geolocation, and orientation permissions unless the page is on `localhost`.

## Notes

The RA/Dec conversion is deterministic astronomy math. The limiting factor is phone orientation accuracy, especially compass calibration and how each browser reports camera tilt.
