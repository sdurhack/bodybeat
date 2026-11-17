// Body Beat: Nicla Vision sketch (no AI model on the board).
//
// Body Beat is a band that plays along with your body. The Nicla is the band's eye and ear:
//   * Picture   the full 320x240 colour frame over USB, sent only when the laptop asks by writing
//               'P'. The laptop's page (laptop/web/live.html) shows it and reads the face's
//               expression on it, which picks the key. Pull, not push: a picture is never left
//               half-sent when a reader closes the port (that jams the mbed USB serial).
//               Format: one text line "IMG <w> <h> rgb565 <bytes>", then the raw RGB565 bytes.
//   * Motion    difference of a 40x30 thumbnail against the previous frame, 0..1, smoothed
//               -> energy -> drum pattern 0..3
//   * Brightness mean luma of the frame, 0..1 (display only; auto exposure is on)
//   * Mic       on-board PDM mic, 16 kHz: loudness above the room's background, and a clap
//               starts a drum fill ({"type":"fill","source":"clap"})
//   * LED       flashes on the band's beat: green = linked to the band, red = on its own
//
// Talking to the band: every state packet (5 a second) is one JSON line on USB serial, which
// live.html reads with Web Serial, so WiFi is optional. With WiFi set below, the same packets
// also go over UDP port 7100 (state / hello / beat / fill), to the laptop and the UNO Q.
//
// Build and upload with arduino-cli (no extra libraries; compiles in about a minute):
//   arduino-cli compile -b arduino:mbed_nicla:nicla_vision nicla_web
//   arduino-cli upload  -b arduino:mbed_nicla:nicla_vision -p COMx nicla_web

#include "camera.h"
#include "gc2145.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include <PDM.h>

// ---- settings ----------------------------------------------------------------------
const char* WIFI_SSID = "";       // blank = USB only (the usual setup)
const char* WIFI_PASS = "";       // never commit a real password
const char* LAPTOP = "";          // optional laptop IP; empty = learn it from the conductor's broadcast
const uint16_t PORT = 7100;
const unsigned long LINK_TIMEOUT_MS = 2500;
const float MOTION_FULL = 25.0f;            // mean thumbnail difference counted as full motion
const float UP[3] = {0.12f, 0.35f, 0.65f};     // energy that steps the drum pattern up (0->1, 1->2, 2->3)
const float DOWN[3] = {0.07f, 0.27f, 0.55f};   // ...and back down: lower, so it does not flicker

// ---- camera ------------------------------------------------------------------------
const int CAM_W = 320, CAM_H = 240;
const int TH_W = 40, TH_H = 30;             // motion thumbnail
bool pictureWanted = false;                 // host wrote 'P'
GC2145 galaxyCore;
Camera cam(galaxyCore);
FrameBuffer fb;
static uint8_t frameMem[CAM_W * CAM_H * 2 + 32];
static uint8_t* frame = nullptr;
static uint8_t thumb[TH_W * TH_H], prevThumb[TH_W * TH_H];
bool haveCam = false, havePrev = false;

// ---- band state --------------------------------------------------------------------
WiFiUDP udp;
bool haveWifi = false;
IPAddress laptopIp, unoqIp;
uint16_t unoqPort = PORT;
bool haveLaptop = false, haveUnoq = false;
unsigned long seenLaptop = 0, seenUnoq = 0;
float bpm = 80.0f;
unsigned long nextBeat = 0, flashUntil = 0, lastState = 0, lastHello = 0;
float energy = 0.0f, brightness = -1.0f;
int pattern = 1;
unsigned long seq = 0, boot = 0;

// ---- microphone (on-board PDM, 16 kHz mono) -------------------------------------------
// Per ~32 ms block: keep the loudest block since the last state packet and a slow
// background level. A block well above the background = a clap.
const float CLAP_RATIO = 6.0f;              // block RMS this many times the background
const float CLAP_MIN_RMS = 4000.0f;         // and at least this loud (int16 units; speech peaks lower)
const unsigned long CLAP_GAP_MS = 400;      // one clap, not one per block
static short pcm[512];
volatile float micPeak = 0.0f, micBackground = 200.0f;
volatile bool clapPending = false;
volatile unsigned long lastClap = 0;
bool haveMic = false;
unsigned long claps = 0;

void onMic() {
  int bytes = PDM.available();
  if (bytes > (int)sizeof(pcm)) bytes = sizeof(pcm);
  PDM.read(pcm, bytes);
  int n = bytes / 2;
  if (n <= 0) return;
  float mean = 0;
  for (int i = 0; i < n; i++) mean += pcm[i];
  mean /= n;
  float ss = 0;
  for (int i = 0; i < n; i++) { float d = pcm[i] - mean; ss += d * d; }
  float rms = sqrtf(ss / n);
  if (rms > micPeak) micPeak = rms;
  unsigned long t = millis();
  if (rms > CLAP_RATIO * micBackground && rms > CLAP_MIN_RMS && t - lastClap > CLAP_GAP_MS) {
    clapPending = true;
    lastClap = t;
  }
  micBackground += (rms - micBackground) * (rms > micBackground ? 0.01f : 0.05f);  // ~3 s rise, fast fall
}

// RMS (int16 units) -> 0..1, log scale: -60 dBFS = 0, 0 dBFS = 1
float level01(float rms) {
  if (rms < 1) return 0;
  float v = (20.0f * log10f(rms / 32768.0f) + 60.0f) / 60.0f;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// LEDs on the Nicla are active LOW
void leds(bool r, bool g, bool b) {
  digitalWrite(LEDR, r ? LOW : HIGH);
  digitalWrite(LEDG, g ? LOW : HIGH);
  digitalWrite(LEDB, b ? LOW : HIGH);
}

inline uint8_t lumaAt(int x, int y) {
  // RGB565, high byte first
  const uint8_t* p = frame + 2 * (y * CAM_W + x);
  uint8_t hb = p[0], lb = p[1];
  int r = hb & 0xF8, g = ((hb & 0x07) << 5) | ((lb & 0xE0) >> 3), b = (lb & 0x1F) << 3;
  return (uint8_t)((r * 77 + g * 150 + b * 29) >> 8);
}

void makeThumb(float& meanOut) {
  long sum = 0;
  for (int ty = 0; ty < TH_H; ty++)
    for (int tx = 0; tx < TH_W; tx++) {
      // average a 4x4 grid inside the 8x8 block: single pixels at 320x240 are too noisy
      int x0 = tx * CAM_W / TH_W, y0 = ty * CAM_H / TH_H, acc = 0;
      for (int dy = 0; dy < 8; dy += 2)
        for (int dx = 0; dx < 8; dx += 2) acc += lumaAt(x0 + dx, y0 + dy);
      uint8_t v = acc >> 4;
      thumb[ty * TH_W + tx] = v;
      sum += v;
    }
  meanOut = sum / (float)(TH_W * TH_H) / 255.0f;
}

// full colour frame -> USB, only while a program has the port open (DTR set)
void sendPicture() {
  if (!Serial) return;
  char head[48];
  snprintf(head, sizeof(head), "IMG %d %d rgb565 %d\n", CAM_W, CAM_H, CAM_W * CAM_H * 2);
  Serial.write((const uint8_t*)head, strlen(head));
  Serial.write(frame, CAM_W * CAM_H * 2);
  Serial.write('\n');
}

// ---- network -------------------------------------------------------------------------
void sendTo(const IPAddress& ip, uint16_t port, const char* msg) {
  udp.beginPacket(ip, port);
  udp.write((const uint8_t*)msg, strlen(msg));
  udp.endPacket();
}

void sendBand(const char* msg) {
  if (!haveWifi) return;
  if (haveLaptop) sendTo(laptopIp, PORT, msg);
  if (haveUnoq) sendTo(unoqIp, unoqPort, msg);
}

bool online(unsigned long seen, bool have) { return have && millis() - seen < LINK_TIMEOUT_MS; }

bool jsonStr(const char* s, const char* key, char* out, size_t n) {
  char pat[32];
  snprintf(pat, sizeof(pat), "\"%s\":\"", key);
  const char* p = strstr(s, pat);
  if (!p) return false;
  p += strlen(pat);
  size_t i = 0;
  while (*p && *p != '"' && i + 1 < n) out[i++] = *p++;
  out[i] = 0;
  return true;
}

bool jsonNum(const char* s, const char* key, float& out) {
  char pat[32];
  snprintf(pat, sizeof(pat), "\"%s\":", key);
  const char* p = strstr(s, pat);
  if (!p) return false;
  p += strlen(pat);
  if (*p == 'n') return false;  // null
  out = atof(p);
  return true;
}

void receive() {
  static char buf[1024];
  while (haveWifi) {
    int n = udp.parsePacket();
    if (n <= 0) return;
    n = udp.read(buf, sizeof(buf) - 1);
    if (n <= 0) return;
    buf[n] = 0;
    char from[16];
    if (!jsonStr(buf, "from", from, sizeof(from)) || !strcmp(from, "nicla")) continue;
    bool relayed = strstr(buf, "\"via\":\"laptop\"") != nullptr;
    if (!relayed) {
      if (!strcmp(from, "laptop")) { laptopIp = udp.remoteIP(); haveLaptop = true; seenLaptop = millis(); }
      if (!strcmp(from, "unoq")) { unoqIp = udp.remoteIP(); unoqPort = udp.remotePort(); haveUnoq = true; seenUnoq = millis(); }
    }
    char type[12];
    jsonStr(buf, "type", type, sizeof(type));
    if (!strcmp(type, "hello") && !haveUnoq) {
      char addr[32];
      if (jsonStr(buf, "unoq", addr, sizeof(addr))) {
        char* colon = strchr(addr, ':');
        if (colon) { *colon = 0; unoqPort = atoi(colon + 1); }
        if (unoqIp.fromString(addr)) haveUnoq = true;
      }
    } else if (!strcmp(type, "beat")) {
      float b;
      if (jsonNum(buf, "bpm", b) && b > 20) bpm = b;
      nextBeat = millis() + (unsigned long)(60000.0f / bpm);
    } else if (!strcmp(type, "state") && !strcmp(from, "unoq")) {
      float b;
      if (jsonNum(buf, "bpm", b) && b > 20) bpm = b;
    }
  }
}

void sendState() {
  static char msg[600];
  char sound[16] = "null", background[16] = "null";
  if (haveMic) {
    noInterrupts();
    float peak = micPeak, bg = micBackground;
    micPeak = 0;
    interrupts();
    snprintf(sound, sizeof(sound), "%.3f", level01(peak));
    snprintf(background, sizeof(background), "%.3f", level01(bg));
  }
  seq++;
  snprintf(msg, sizeof(msg),
           "{\"from\":\"nicla\",\"type\":\"state\",\"seq\":%lu,\"boot\":%lu,\"mode\":\"vision\","
           "\"energy\":%.3f,\"pattern\":%d,\"brightness\":%.3f,"
           "\"person_present\":null,\"person_confidence\":null,"
           "\"vision_method\":\"motion+mic\",\"inference_ms\":null,"
           "\"sound_level\":%s,\"sound_background\":%s,\"claps\":%lu,"
           "\"distance_mm\":null,\"links\":{\"laptop\":%s,\"unoq\":%s}}",
           seq, boot, energy, pattern, brightness < 0 ? 0.0f : brightness,
           sound, background, claps,
           online(seenLaptop, haveLaptop) ? "true" : "false",
           online(seenUnoq, haveUnoq) ? "true" : "false");
  Serial.println(msg);
  sendBand(msg);
}

// ---- setup / loop --------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LEDR, OUTPUT); pinMode(LEDG, OUTPUT); pinMode(LEDB, OUTPUT);
  leds(false, false, true);
  randomSeed(micros());
  boot = (unsigned long)random(1, 0x3FFFFFFF);

  frame = (uint8_t*)(((uintptr_t)frameMem + 31) & ~(uintptr_t)31);  // 32-byte aligned for DMA
  fb.setBuffer(frame);
  haveCam = cam.begin(CAMERA_R320x240, CAMERA_RGB565, 30);
  Serial.println(haveCam ? "camera ok 320x240 colour" : "camera FAILED");

  PDM.onReceive(onMic);
  haveMic = PDM.begin(1, 16000);
  Serial.println(haveMic ? "mic ok 16 kHz" : "mic FAILED");
  Serial.println("Body Beat Nicla: camera picture + motion + mic, no on-board model");

  if (strlen(WIFI_SSID)) {
    for (int i = 0; i < 3 && WiFi.status() != WL_CONNECTED; i++) {
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      delay(2000);
    }
    haveWifi = WiFi.status() == WL_CONNECTED;
    Serial.print("wifi ");
    Serial.println(haveWifi ? WiFi.localIP() : IPAddress(0, 0, 0, 0));
    if (haveWifi) {
      udp.begin(PORT);
      if (strlen(LAPTOP) && laptopIp.fromString(LAPTOP)) haveLaptop = true;
    }
  }
  nextBeat = millis();
  leds(false, false, false);
}

void loop() {
  unsigned long now = millis();
  receive();
  while (Serial.available() > 0)
    if (Serial.read() == 'P') pictureWanted = true;

  if (haveCam && cam.grabFrame(fb, 100) == 0) {
    float b;
    makeThumb(b);
    brightness = brightness < 0 ? b : brightness + (b - brightness) * 0.2f;
    if (havePrev) {
      long diff = 0;
      for (int i = 0; i < TH_W * TH_H; i++) diff += abs((int)thumb[i] - (int)prevThumb[i]);
      float motion = diff / (float)(TH_W * TH_H) / MOTION_FULL;
      if (motion > 1.0f) motion = 1.0f;
      float k = motion > energy ? 0.4f : 0.03f;    // quick to rise, slow to settle
      energy += (motion - energy) * k;
      if (pattern < 3 && energy > UP[pattern]) pattern++;
      else if (pattern > 0 && energy < DOWN[pattern - 1]) pattern--;
    }
    memcpy(prevThumb, thumb, sizeof(thumb));
    havePrev = true;
    if (pictureWanted) {
      pictureWanted = false;
      sendPicture();
    }
  }

  if (clapPending) {
    clapPending = false;
    claps++;
    char fill[96];
    snprintf(fill, sizeof(fill), "{\"from\":\"nicla\",\"type\":\"fill\",\"boot\":%lu,\"source\":\"clap\"}", boot);
    Serial.println(fill);
    sendBand(fill);
  }

  if (haveWifi && !haveLaptop && now - lastHello > 2000) {
    lastHello = now;
    sendTo(IPAddress(255, 255, 255, 255), PORT, "{\"from\":\"nicla\",\"type\":\"hello\"}");
  }

  if (now - lastState >= 200) {   // 5 Hz state for the band
    lastState = now;
    sendState();
  }

  if ((long)(now - nextBeat) >= 0) {
    nextBeat += (unsigned long)(60000.0f / bpm);
    if ((long)(now - nextBeat) > 0) nextBeat = now + (unsigned long)(60000.0f / bpm);
    flashUntil = now + 80;
    bool linked = online(seenLaptop, haveLaptop) || online(seenUnoq, haveUnoq);
    leds(!linked, linked, false);
  }
  if ((long)(now - flashUntil) > 0) leds(false, false, false);
}
