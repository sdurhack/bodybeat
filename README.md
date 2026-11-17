# BodyBeats

**An orchestra for your body.** Your heartbeat sets the tempo, your facial expression picks the key,
and movements in front of the Nicla Vision camera shape the drums and melody. A clap triggers a drum fill.
The Arduino UNO Q, one Modulino Light, the Nicla Vision and a laptop browser each play a part.
Five coloured LEDs run a light show on the UNO Q's beat; a separate red LED illuminates your fingertip.

Built at DurHack 2026.

![BodyBeats wiring, using only the actual hardware](docs/circuit.svg)

There is also an interactive 3D model of the build: open [`docs/circuit3d.html`](docs/circuit3d.html) in a browser
(download it first; GitHub shows it as source).

## How it plays

| You do | Sensed by | The band does |
|---|---|---|
| Rest a fingertip on the red LED | Modulino Light (pulse, 40 readings a second) | **Tempo** follows your heart rate, and holds it if your finger slips |
| Make a face | Nicla Vision camera → expression model in the browser | **Key**: happy / surprised = C major, neutral = D dorian, sad / angry / fearful / disgusted = A minor |
| Move in front of the camera | Nicla Vision (frame difference) | **Drums** get busier, from 4 patterns; activity also shapes melody density |
| Clap | Nicla Vision microphone | **Drum fill** |
| Walk away | no face for 10 s | The band drops to a quiet backing |

The laptop browser is the only thing that makes sound (Web Audio: drums, bass, pads and leads, with reverb,
echo and a limiter). It can also play your own Spotify playlists, picking the energy from your heart rate.

## Hardware

| Part | Notes |
|---|---|
| Arduino UNO Q | MCU half runs `unoq/sketch`, Linux half runs `unoq/python` (band clock, pulse) |
| Modulino Light | One Qwiic cable: UNO Q → Modulino Light |
| 5 LEDs + 220 Ω | D2 blue, D3 blue, D4 yellow, D5 green, D6 green: status lights, then the light show |
| 1 red LED + 3 × 37 Ω in series | D7, always on: shines through the fingertip onto the Light sensor |
| Arduino Nicla Vision | USB-C to the laptop. Camera picture, motion, mic. No model on the board |
| Laptop | Python 3 + Chrome or Edge (Web Serial) |

Each LED: pin → resistor → long leg (+); short leg (−) → GND. The full pin table is at the top of
[`unoq/sketch/sketch.ino`](unoq/sketch/sketch.ino).

## Run it

**1. Nicla Vision** (once; about 5 minutes the first time):

```
arduino-cli compile -b arduino:mbed_nicla:nicla_vision nicla_web
arduino-cli upload  -b arduino:mbed_nicla:nicla_vision -p COM11 nicla_web
```

**2. UNO Q** (once): connect only Modulino Light via Qwiic. Wire the five show LEDs to D2–D6 through 220 Ω series resistors and the red pulse LED to D7 through three 37 Ω resistors in series. Import `unoq/` into Arduino App Lab, add `Arduino_Modulino`, and run it.
The board must know the laptop's address: put it in `unoq/python/peers.txt` (one address per line), or set `BB_PEERS`.
Put the UNO Q and the laptop on the same WiFi.

**3. Laptop** (every time):

```
python laptop/conductor.py              # with the UNO Q
python laptop/conductor.py --sim        # no hardware: a simulated UNO Q and Nicla
python laptop/conductor.py --peer <UNO Q IP>   # WiFi that blocks broadcasts
```

Open **http://127.0.0.1:8000** in Chrome or Edge, click **Start the band**, then **Connect Nicla (USB)**. Place a fingertip between the red LED and Light sensor; try facial expressions, camera movement and a clap.
Optional: **Start mic**, **Send clock**, **Start webcam** (a webcam pulse stands in when there is no finger pulse).

## The custom face model

The key comes from our custom expression model, trained on FER2013 with Microsoft's FER+ labels
([`model/train_expression.ipynb`](model/train_expression.ipynb), about 20 minutes on a free Colab GPU).
[face-api](https://github.com/vladmandic/face-api) finds the face; the custom model reads the expression on it.

| FER+ test faces | 7 expressions | 3 keys | Size |
|---|---|---|---|
| face-api expression model | 64.7% | 73.3% | 322 KB |
| **BodyBeats custom model** | **79.8%** | **83.3%** | **109 KB** |

It runs in the browser on plain tf.js ops, checks itself against the notebook's answers when it loads, and falls back
to face-api if anything is wrong. The **Expression model** menu can switch to face-api, or show both side by side.
Details and caveats: [`model/README.md`](model/README.md).

## Spotify (optional)

Instead of the generated band, BodyBeats can play your own Spotify playlists on a phone or desktop app:
your heart rate picks Warm-up, Steady (from 100 BPM) or High energy (from 135 BPM), and the playlist changes a few
seconds after you enter a new range. It never skips a track or overrides your pause.

1. Create a Spotify app at https://developer.spotify.com/dashboard with the redirect URI `http://127.0.0.1:8000/live.html`. Select Web API as needed. A **Client ID** identifies the app; a **Client Secret must never be pasted into the browser or committed to GitHub**.
   Development-mode apps need a Premium account, and each listener added under *User Management*.
2. Run `python laptop/conductor.py` and open http://127.0.0.1:8000/live.html. Choose **Spotify**, paste **your own Spotify app Client ID** into the field, and click **Connect**. The browser uses Authorization Code with PKCE; it does not need a Client Secret.
3. In the Spotify Developer Dashboard, add your Spotify user under the app’s **User Management** if the app is in development mode. Sign in with that user and a Spotify Premium account (required for playback control). Open Spotify on a phone or desktop, click **Refresh**, select the playback device, paste playlist links for Warm-up, Steady and High energy, then click **Play**. Heart rate selects the playlist level; the generated band resumes if Spotify stops.

**Credential safety:** sign-in uses Authorization Code + PKCE, not a Spotify Client Secret. Access and refresh tokens are stored in browser session storage for that tab, never in the repository. Do not commit Spotify keys, OAuth codes, tokens, `.env` files or personal credentials. A Client ID is a public identifier, but this repo does not ship a team member’s ID.

## How the pieces stay in time

- Every device talks over UDP port 7100 and sends its state 5 times a second. 2.5 s of silence = offline.
- **The band clock lives on the UNO Q.** It eases towards your heart rate; with no pulse it holds the last tempo.
- If a link drops, everyone keeps playing from the last state they heard, and the status LEDs blink. When it comes back, the
  laptop pulls its grid back onto the UNO Q's beat within a few beats.
- The UNO Q runs the light show on its own beat clock (200 updates a second), so it stays on the beat over laggy WiFi.

## Repository

```
laptop/conductor.py        relays the band to the browser (HTTP :8000, UDP 7100)
laptop/web/live.html       the band: sound, face model, Nicla over Web Serial, Spotify
laptop/web/live/           fusion.js (decisions), engine.js (sound), expression.js (custom model), ...
unoq/sketch/               UNO Q MCU: sensors, LED matrix, light show
unoq/python/               UNO Q Linux: band clock, pulse detection, networking
nicla_web/                 Nicla Vision sketch: picture, motion, mic
model/                     training notebook for the face model
docs/                      corrected wiring diagram (SVG) and the 3D model
tests/                     python tests/test_band.py · python tests/test_pulse.py · node tests/test_web_live.mjs
```

The tests need no hardware and no packages.

## Credits

Made at DurHack 2026 by:

- **Melanie**: the face-expression model
- **Letmela**: the band, and the hardware–software integration
- **Manasseh Portuphy**: the circuit, and the hardware–software integration

The hackathon history lives in [sdurhack/repo1](https://github.com/sdurhack/repo1).

Open-source work this builds on: [face-api](https://github.com/vladmandic/face-api) (MIT), Microsoft's
[FER+](https://github.com/microsoft/FERPlus) labels (MIT) on the FER2013 faces, and the POS remote-pulse method
(Wang et al., 2017) for the webcam pulse.

## Licence

MIT, see [LICENSE](LICENSE). `laptop/web/live/vendor/` keeps face-api's own MIT licence.
