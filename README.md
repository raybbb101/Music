# Air Strings

Play a guitar made of air. An installable web app (PWA) for Chrome that uses your camera
to track your hands.

1. **Pinch** thumb + index finger on **both hands** — a line stretches between them.
2. **Release** — the string stays. Short string = low note, long string = high note.
3. **Swipe** your index finger across a string to pluck it like a guitar.

You can also strum with the mouse or a finger on a touchscreen. Strings are saved between visits.
Notes snap to a pentatonic scale (E2–E5) so every combination sounds good.

## Run / install

The camera only works on `https://` or `localhost`.

- Local: `python3 -m http.server 8000`, then open http://localhost:8000 in Chrome.
- Online: enable **GitHub Pages** for this repo (Settings → Pages → deploy from branch).

In Chrome, click the **install** icon in the address bar (or the *Install app* button) to
install it as an app.

Hand tracking: [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).
Sound: Karplus-Strong plucked-string synthesis with the Web Audio API.
