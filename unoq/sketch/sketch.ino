// Body Beat: UNO Q sketch (the MCU half of the board; python/main.py is the Linux half).
//
// Body Beat is a band that plays along with your body. This board reads a fingertip pulse,
// keeps the band's clock, and runs a five-LED light show on the beat.
//
// What this sketch does (all decisions are made in python/, so tuning needs no reflash):
//   * Pulse   Modulino Light, measuring continuously; every fresh reading goes to Python as "ppg"
//             (~40 Hz): t_ms, ir, red, green, blue (raw 16-bit counts)
//   * Health  "diag" every 2 s: light sensor found, fresh readings so far, reading rate x10
//   * Shows   the tempo and the beat on the LED matrix, and the light show on D2-D6
//
// Wiring
//   Qwiic cable: UNO Q -> Modulino Light
//   Each LED: pin -> resistor -> LED long leg (+); LED short leg (-) -> GND
//   | Pin | LED          | Resistor        | Light show (while the laptop plays) | Status (laptop quiet 3 s) |
//   |-----|--------------|-----------------|-------------------------------------|---------------------------|
//   | D2  | blue         | 220 ohm         | snare, downbeats                    | beat                      |
//   | D3  | blue  (PWM)  | 220 ohm         | snare, kick ripple                  | minor key                 |
//   | D4  | yellow       | 220 ohm         | kick, centre of the ripple          | major key                 |
//   | D5  | green (PWM)  | 220 ohm         | hi-hats, kick ripple                | laptop link: steady / blink = offline |
//   | D6  | green (PWM)  | 220 ohm         | hi-hats, downbeats                  | Nicla data: steady / blink = stale    |
//   | D7  | red, bright  | 3 x 37 ohm      | always on: lights the fingertip for the pulse sensor           |
//   D3 and D4 both on = dorian (in between). Put the fingertip between the red LED and the
//   Light sensor (LED on the nail, sensor on the pad), or the sensor right next to the LED.
//
// Why the light sensor is read by hand: ModulinoLight / LTR381RGBClass::readRawColors() switch
// the sensor on, wait in 50 ms steps, read once and switch it off, so the real rate is ~10 Hz
// and uneven, and ModulinoLight only gives 8-bit colours (a pulse is ~1% of the signal). Here
// the library only CONFIGURES the chip (gain, 25 ms rate, 16-bit); the chip then measures
// continuously and a reading is taken only when its data-ready flag is set.
//
// Libraries: Arduino_Modulino (add it in App Lab; it brings Arduino_LTR381RGB).
// Arduino_RouterBridge and Arduino_LED_Matrix ship with the UNO Q core.

#include <Arduino_RouterBridge.h>
#include <Arduino_Modulino.h>
#include <Arduino_LED_Matrix.h>

// ---- pins: the one place to change if a wire moves -----------------------------
// The five show LEDs, left to right. D3, D5 and D6 can fade (PWM); D2 and D4 can only flash.
const int SHOW_PIN[5] = {2, 3, 4, 5, 6};
const bool SHOW_PWM[5] = {false, true, false, true, true};
enum { L_D2 = 0, L_D3 = 1, L_D4 = 2, L_D5 = 3, L_D6 = 4 };   // index into SHOW_PIN
const int PIN_PULSE_LED = 7;   // red, always on: lights the fingertip for the pulse sensor

// ---- Modulino Light (LTR381 at 0x53 on the Qwiic bus = Wire1) ---------------
const uint8_t LTR_ADDR = 0x53;
const uint8_t REG_MAIN_CTRL = 0x00, REG_GAIN = 0x05, REG_STATUS = 0x07, REG_DATA_IR = 0x0A;
const int GAINS[] = {ALS_CS_GAIN_1, ALS_CS_GAIN_3, ALS_CS_GAIN_6, ALS_CS_GAIN_9, ALS_CS_GAIN_18};
const long FULL = 65535;  // 16-bit resolution
LTR381RGBClass ltr(Wire1, LTR_ADDR);
int gainIdx = 1;          // start at 3x; auto-adjusted below
bool haveLight = false;
unsigned long lightReads = 0, readsAtDiag = 0;

Arduino_LED_Matrix matrix;

volatile int shownBpm = 0, mood = 1, linkLaptop = 0, linkNicla = 0;
volatile unsigned long flashUntil = 0, lastStatus = 0;

int ltrWrite(uint8_t reg, uint8_t v) {
  Wire1.beginTransmission(LTR_ADDR);
  Wire1.write(reg);
  Wire1.write(v);
  return Wire1.endTransmission() == 0;
}

int ltrRead(uint8_t reg, uint8_t* buf, int n) {
  Wire1.beginTransmission(LTR_ADDR);
  Wire1.write(reg);
  if (Wire1.endTransmission(false) != 0) return 0;
  if (Wire1.requestFrom(LTR_ADDR, (uint8_t)n) != n) return 0;
  for (int i = 0; i < n; i++) buf[i] = Wire1.read();
  return 1;
}

bool startLight() {
  // Library does the part-ID check and sets gain, 25 ms measurement rate, 16-bit.
  if (!ltr.begin(GAINS[gainIdx], ADC_MEAS_RATE_25MS, ADC_RES_16BIT)) return false;
  return ltrWrite(REG_MAIN_CTRL, 0x06);  // CS (colour) mode + enable: measure continuously
}

// Returns true only for a NEW measurement. 12 bytes from 0x0A: IR, G, R, B (3 bytes each, LSB first).
bool readLight(long& ir, long& r, long& g, long& b) {
  static unsigned long lastOk = 0;
  uint8_t st;
  if (!ltrRead(REG_STATUS, &st, 1)) return false;
  if (st & 0x20) { haveLight = startLight(); return false; }  // chip power-on reset: reconfigure
  if (!(st & 0x08)) return false;                            // no new data yet
  if (millis() - lastOk < 20) return false;  // never faster than the 25 ms integration
  uint8_t d[12];
  if (!ltrRead(REG_DATA_IR, d, 12)) return false;
  lastOk = millis();
  ir = ((long)d[2] << 16 | (long)d[1] << 8 | d[0]) & 0xFFFFF;
  g  = ((long)d[5] << 16 | (long)d[4] << 8 | d[3]) & 0xFFFFF;
  r  = ((long)d[8] << 16 | (long)d[7] << 8 | d[6]) & 0xFFFFF;
  b  = ((long)d[11] << 16 | (long)d[10] << 8 | d[9]) & 0xFFFFF;
  return true;
}

// Keep the brightest channel inside the ADC range: step gain down near clipping,
// up when everything is tiny. Python sees the step as a jump and blanks beats briefly.
void autoGain(long peak) {
  static unsigned long since = 0;
  static long winMax = 0;
  if (peak > winMax) winMax = peak;
  if (millis() - since < 1000) return;
  since = millis();
  int want = gainIdx;
  if (winMax > FULL * 92 / 100 && gainIdx > 0) want--;
  else if (winMax < 1500 && gainIdx < 4) want++;
  winMax = 0;
  if (want != gainIdx) { gainIdx = want; ltrWrite(REG_GAIN, GAINS[gainIdx] & 0x07); }
}

// ---- LED matrix: 3x5 digits, 13 wide x 8 tall ------------------------------
const uint8_t DIGITS[10][5] = {
  {7,5,5,5,7},{2,6,2,2,7},{7,1,7,4,7},{7,1,7,1,7},{5,5,7,1,1},
  {7,4,7,1,7},{7,4,7,5,7},{7,1,1,1,1},{7,5,7,5,7},{7,5,7,1,7}};
uint8_t frame[8 * 13];

void px(int x, int y, uint8_t v) { if (x >= 0 && x < 13 && y >= 0 && y < 8) frame[y * 13 + x] = v; }

void drawDigit(int d, int x0, int y0) {
  for (int r = 0; r < 5; r++)
    for (int c = 0; c < 3; c++)
      if (DIGITS[d][r] & (4 >> c)) px(x0 + c, y0 + r, 1);
}

bool blinkOn() { return (millis() / 250) % 2; }  // 2 Hz "offline" blink

void render() {
  bool flash = millis() < flashUntil;
  memset(frame, 0, sizeof(frame));
  int bpm = shownBpm;
  if (bpm <= 0) {
    for (int x = 1; x < 12; x += 4) { px(x, 2, 1); px(x + 1, 2, 1); }
  } else {
    if (bpm > 999) bpm = 999;
    int d[3] = {bpm / 100, (bpm / 10) % 10, bpm % 10};
    for (int i = 0, x = 1; i < 3; i++, x += 4)
      if (i > 0 || d[0] > 0) drawDigit(d[i], x, 0);
  }
  // row 6: link dots. Left = laptop, right = Nicla. Steady = online, blinking = offline.
  px(0, 6, linkLaptop || blinkOn());
  px(12, 6, linkNicla || blinkOn());
  for (int x = 0; x < 13; x++) px(x, 7, flash);  // bottom row flashes on every beat
  matrix.draw(frame);
}

// ---- light show ------------------------------------------------------------
// The same choreography as laptop/web/live/lights.js (keep them in step). The laptop sends
// what is playing ~5x a second ("show"); the beats come from THIS board's band clock
// ("tick" from python/main.py), so the lights stay on the beat even over a laggy WiFi.
const unsigned long LIGHT_LAG = 30;   // ms: sound leaves the laptop speakers a little after the beat
float env[5] = {0}, tauMs[5] = {100, 100, 100, 100, 100};
struct Hit { unsigned long at; uint8_t led; float v; uint16_t tau; };
Hit hq[32]; int hn = 0;
volatile int shPlaying = 0, shPattern = 1, shLevel = 1, shSrc = 0, shEnergy = 40, shMood = 1, shFill = 0;
volatile unsigned long showT = 0, tickT = 0;
volatile long tickIdx = -1;
volatile int tickMs = 750;
long last16 = -100000;

// drum steps per pattern, as bit masks over the 16 steps (same as engine.js)
const uint16_t KICK[4]  = {0x0001, 0x0101, 0x0101, 0x0941};
const uint16_t SNARE[4] = {0x0000, 0x0000, 0x1010, 0x1010};
const uint16_t HAT[4]   = {0x0000, 0x1010, 0x5555, 0xFFFF};
const uint16_t OPEN[4]  = {0x0000, 0x0000, 0x4000, 0x4040};
bool on16(uint16_t m, int i) { return (m >> i) & 1; }

void hit(int led, float v, int tau, int delayMs = 0) {
  if (hn < 32) hq[hn++] = {millis() + delayMs, (uint8_t)led, v, (uint16_t)tau};
}

void lightStep(int i) {
  int pat = shSrc == 1 ? shLevel + 1 : shPattern;
  if (pat == 4) {  // breakdown: one slow swell per bar from the centre
    if (i == 0) { hit(L_D4, 0.8, 900); hit(L_D3, 0.5, 900, 150); hit(L_D5, 0.5, 900, 150); }
    return;
  }
  if (shFill && i == 0) for (int k = 0; k < 5; k++) hit(k, 1, 500);
  if (shFill && i >= 12) { int k = i - 12; hit(k, 1, 110); hit(k + 1, 1, 110); return; }
  if (pat < 0) pat = 0;
  if (pat > 3) pat = 3;
  if (on16(KICK[pat], i)) {
    hit(L_D4, 1, 170); hit(L_D3, 0.6, 140, 35); hit(L_D5, 0.6, 140, 35);
    if (shLevel >= 1) { hit(L_D2, 0.3, 120, 70); hit(L_D6, 0.3, 120, 70); }
  }
  if (on16(SNARE[pat], i)) { hit(L_D2, 1, 150); hit(L_D3, 0.85, 150); if (shLevel == 2) hit(L_D4, 0.5, 90, 20); }
  if (on16(OPEN[pat], i)) { hit(L_D5, 0.85, 280); hit(L_D6, 0.85, 280); }
  else if (on16(HAT[pat], i)) hit((i >> 1) & 1 ? L_D6 : L_D5, i % 4 == 2 ? 0.7 : 0.4, 60);
  if (i == 0 && shLevel >= 1 && !shFill) { hit(L_D2, 0.7, 220, 90); hit(L_D6, 0.7, 220, 90); }
  if (shLevel == 2 && i % 2 == 1) { const int ch[5] = {L_D2, L_D3, L_D4, L_D5, L_D6}; hit(ch[(i >> 1) % 5], 0.3, 50); }
}

void lightAmbient(float beats, unsigned long ms, float* out) {
  for (int i = 0; i < 5; i++) out[i] = 0;
  if (!shPlaying) { out[L_D4] = 0.15 * (0.5 + 0.5 * sin(2 * PI * ms / 4000.0)); return; }
  const float speeds[3] = {0.5, 1, 2};
  float speed = speeds[constrain(shLevel, 0, 2)];
  float amp = (shPattern == 4 && shSrc != 1) ? 0.25 : 0.05 + 0.12 * shEnergy / 100.0;
  const float minor[5] = {1.5, 1.5, 0.8, 0.6, 0.6}, major[5] = {0.6, 0.6, 1.4, 1.3, 1.3};
  for (int i = 0; i < 5; i++) {
    float tint = shMood == 0 ? minor[i] : shMood == 2 ? major[i] : 1;
    out[i] = amp * tint * (0.5 + 0.5 * sin(2 * PI * beats * speed - i * 1.1));
  }
}

void setLed(int i, float b) {
  if (b < 0) b = 0;
  if (b > 1) b = 1;
  if (SHOW_PWM[i]) analogWrite(SHOW_PIN[i], (int)(pow(b, 2.2) * 255));   // gamma: fades look even
  else digitalWrite(SHOW_PIN[i], b > 0.33);
}

void lightShow() {
  static unsigned long lastMs = 0;
  unsigned long now = millis();
  float dt = lastMs ? (float)(now - lastMs) : 0;
  lastMs = now;
  // where the band clock is: beats since the last tick, carried on if the ticks stop
  float beats = 0;
  if (tickIdx >= 0) {
    long el = (long)(now - tickT) - (long)LIGHT_LAG;
    beats = tickIdx + (float)el / (tickMs > 0 ? tickMs : 750);
    long s16 = (long)floor(beats * 4);
    if (s16 < last16 - 8) last16 = s16 - 1;          // clock jumped back (board restart): resync
    if (s16 > last16) {
      last16 = s16;
      if (shPlaying) lightStep((int)(((s16 % 16) + 16) % 16));
    }
  }
  for (int i = 0; i < 5; i++) env[i] *= exp(-dt / tauMs[i]);
  for (int k = 0; k < hn;) {
    if ((long)(now - hq[k].at) >= 0) {
      Hit h = hq[k];
      if (h.v >= env[h.led]) { env[h.led] = h.v; tauMs[h.led] = h.tau; }
      hq[k] = hq[--hn];
    } else k++;
  }
  float amb[5];
  lightAmbient(beats, now, amb);
  for (int i = 0; i < 5; i++) setLed(i, env[i] > amb[i] ? env[i] : amb[i]);
}

// The five LEDs: the light show while the laptop is playing, else their status meanings.
void leds() {
  if (showT && millis() - showT < 3000) { lightShow(); return; }
  bool stale = millis() - lastStatus > 3000;  // Linux side silent: show both links down
  setLed(L_D2, millis() < flashUntil);        // beat
  setLed(L_D3, mood <= 1);                    // minor (mood 0) or dorian (1)
  setLed(L_D4, mood >= 1);                    // major (mood 2) or dorian (1)
  setLed(L_D5, (linkLaptop && !stale) || ((!linkLaptop || stale) && blinkOn()));   // laptop link
  setLed(L_D6, (linkNicla && !stale) || ((!linkNicla || stale) && blinkOn()));     // Nicla data
}

// ---- called from Linux -----------------------------------------------------
void showBpm(int bpm) { shownBpm = bpm; }
void beat() { flashUntil = millis() + 90; }
void tick(int index, int beatMs) { tickIdx = index; tickMs = beatMs; tickT = millis(); }
void show(int playing, int pattern, int level, int src, int energy, int mood_, int fill) {
  shPlaying = playing; shPattern = pattern; shLevel = level; shSrc = src;
  shEnergy = energy; shMood = mood_; shFill = fill; showT = millis();
}
void status(int m, int laptop, int nicla) {
  mood = m; linkLaptop = laptop; linkNicla = nicla; lastStatus = millis();
}

void setup() {
  // LED self-test: all six on for 0.3 s, so you can see the wiring works
  for (int i = 0; i < 5; i++) { pinMode(SHOW_PIN[i], OUTPUT); digitalWrite(SHOW_PIN[i], HIGH); }
  pinMode(PIN_PULSE_LED, OUTPUT);
  digitalWrite(PIN_PULSE_LED, HIGH);   // and the pulse LED simply stays on
  delay(300);
  Bridge.begin();
  Bridge.provide("show_bpm", showBpm);
  Bridge.provide("beat", beat);
  Bridge.provide("status", status);
  Bridge.provide("tick", tick);
  Bridge.provide("show", show);
  matrix.begin();
  Modulino.begin(Wire1);  // Qwiic connector on the UNO Q is Wire1
  haveLight = startLight();
}

void loop() {
  static unsigned long lastDraw = 0, lastDiag = 0;
  long ir, r, g, b;
  if (haveLight && readLight(ir, r, g, b)) {
    lightReads++;
    long peak = ir > r ? ir : r;
    if (g > peak) peak = g;
    if (b > peak) peak = b;
    autoGain(peak);
    // -> python on_ppg(t_ms, ir, r, g, b)
    Bridge.notify("ppg", (long)millis(), ir, r, g, b);
  }
  if (millis() - lastDiag >= 2000) {
    unsigned long dt = millis() - lastDiag;
    lastDiag = millis();
    long rate10 = (long)((lightReads - readsAtDiag) * 10000UL / (dt ? dt : 1));
    readsAtDiag = lightReads;
    if (!haveLight) haveLight = startLight();  // plugged in late? try again
    // -> python on_diag(have_light, reads, rate_x10)
    Bridge.notify("diag", (int)haveLight, (long)lightReads, rate10);
  }
  if (millis() - lastDraw > 30) { lastDraw = millis(); render(); }
  static unsigned long lastLeds = 0;
  if (millis() - lastLeds >= 5) { lastLeds = millis(); leds(); }   // 200 Hz: smooth fades, tight flashes
}
