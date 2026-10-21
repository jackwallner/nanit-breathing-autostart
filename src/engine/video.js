// The camera's picture, read the way the Nanit app reads it. Nanit's cloud relays the camera's
// RTMPS push at <media>/<baby uid>.<access token>, and any valid token for the baby can read it.
// One ffmpeg reads it at a frame a second and the monitor takes the newest frame. When nothing is
// being pushed, ffmpeg can't open the stream; then the camera is asked to push (PUT_STREAMING,
// through the monitor's camera socket) and ffmpeg tries again. Frames are the camera's
// 1920 x 1080, so Breathing Wear points stay in camera coordinates.
//
// While monitoring is running normally nothing needs the picture, so the monitor pauses the
// reader and the stream isn't downloaded.
import { spawn as spawnProcess } from "node:child_process";

export const WIDTH = 1920;
export const HEIGHT = 1080;
const FRAME = WIDTH * HEIGHT * 3;
const STALE = 20_000; // no new frame this long: restart ffmpeg
const FRESH = 4_000; // a frame this old still counts as live
const RETRY = [5_000, 15_000, 30_000, 60_000];

// The stream URL carries an access token; ffmpeg prints it in its errors.
export const redact = (text) => String(text).replace(/(nanit\/[^/.\s]+\.)[A-Za-z0-9._-]+/g, "$1<token>");

// ffmpeg's input arguments for the live stream. Certificates are checked against the system's
// roots (the bundled ffmpeg uses the operating system's TLS).
export const streamInput = (media) => (babyUid, accessToken) =>
  ["-tls_verify", "1", "-rw_timeout", "15000000", "-i", `${media}/${babyUid}.${accessToken}`];

// 32 x 18 grey thumbnail: the mean of each 60 x 60 block.
export function thumbnail(data, width = WIDTH, height = HEIGHT) {
  const bw = width / 32, bh = height / 18;
  const grey = [];
  for (let by = 0; by < 18; by++) {
    for (let bx = 0; bx < 32; bx++) {
      let sum = 0;
      for (let y = by * bh; y < (by + 1) * bh; y++) {
        let at = (y * width + bx * bw) * 3;
        for (let x = 0; x < bw; x++, at += 3) sum += data[at] + data[at + 1] + data[at + 2];
      }
      grey.push(Math.round(sum / (3 * bw * bh)));
    }
  }
  return grey;
}

// Night vision is near-grey: fewer than 2% of sampled pixels show any colour.
export function infrared(data) {
  let colour = 0, samples = 0;
  for (let at = 0; at < data.length; at += 3 * 97) {
    samples++;
    const r = data[at], g = data[at + 1], b = data[at + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) colour++;
  }
  return colour / samples < 0.02;
}

export function nanitVideo({ ffmpegBin, babyUid, token, input, requestStream = async () => {}, log = () => {},
  spawn = spawnProcess, now = Date.now, setTimer = setTimeout }) {
  let child = null, latest = null, failures = 0, retryTimer = null, stopped = false, paused = false;
  const options = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };

  const schedule = (delay) => {
    if (retryTimer || stopped || paused) return;
    retryTimer = setTimer(() => { retryTimer = null; start(); }, delay);
  };

  async function start() {
    paused = false;
    if (child || stopped) return;
    let accessToken;
    try { accessToken = await token(); }
    catch (error) {
      log("video token failed", { error: String(error?.message ?? error).slice(0, 300) });
      return schedule(60_000);
    }
    if (child || paused || stopped) return;
    const proc = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "error", ...input(babyUid, accessToken), "-an",
      "-vf", `fps=1,scale=${WIDTH}:${HEIGHT}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], options);
    child = proc;
    const startedAt = now();
    let frame = Buffer.allocUnsafe(FRAME), filled = 0, frames = 0, errors = "";
    proc.stderr.on("data", (text) => { errors = (errors + text).slice(-1_000); });
    proc.stdout.on("data", (chunk) => {
      for (let at = 0; at < chunk.length;) {
        const n = Math.min(FRAME - filled, chunk.length - at);
        chunk.copy(frame, filled, at, at + n);
        filled += n; at += n;
        if (filled === FRAME) {
          latest = { data: frame, at: now() };
          frame = Buffer.allocUnsafe(FRAME); filled = 0; frames++; failures = 0;
        }
      }
    });
    const watchdog = setInterval(() => {
      if (now() - (latest && latest.at > startedAt ? latest.at : startedAt) > STALE) proc.kill("SIGKILL");
    }, 5_000);
    // A spawn that fails (ffmpeg missing, or blocked by antivirus) reports only "error", never
    // "exit", so both end the run, once.
    let ended = false;
    proc.on("error", (error) => { errors += String(error?.message ?? error); if (proc.pid === undefined) finish(null, null); });
    proc.on("exit", (code, signal) => finish(code, signal));
    async function finish(code, signal) {
      if (ended) return;
      ended = true;
      clearInterval(watchdog);
      if (child === proc) child = null;
      if (paused || stopped) return;
      log("video stopped", { code, signal, frames, error: redact(errors.trim()).slice(0, 300) || undefined });
      if (frames > 0) return schedule(2_000);
      // ffmpeg itself wouldn't run (missing, or blocked by antivirus): no use asking the camera.
      if (proc.pid === undefined) { log("ffmpeg can't run", { bin: ffmpegBin }); return schedule(60_000); }
      // Nothing came through: most likely nobody is pushing. Ask the camera, then try again.
      const delay = RETRY[Math.min(failures, RETRY.length - 1)];
      failures++;
      try { await requestStream(); log("stream requested"); }
      catch (error) { log("stream request failed", { error: redact(error?.message ?? error).slice(0, 300) }); }
      schedule(delay);
    }
  }

  // The newest frame no older than maxAge, waiting up to `wait` for one.
  const live = async ({ maxAge = FRESH, wait = 8_000 } = {}) => {
    start();
    for (let waited = 0; ; waited += 250) {
      if (latest && now() - latest.at <= maxAge) return latest;
      if (waited >= wait) return null;
      await new Promise((resolve) => setTimer(resolve, 250));
    }
  };

  const encode = (data, args) => new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${WIDTH}x${HEIGHT}`,
      "-i", "pipe:0", ...args, "-frames:v", "1", "-f", "image2pipe", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [];
    let errors = "";
    const timer = setTimer(() => proc.kill("SIGKILL"), 30_000);
    proc.stdout.on("data", (chunk) => out.push(chunk));
    proc.stderr.on("data", (text) => { errors += text; });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg couldn't encode the frame (${code}): ${errors.slice(0, 200)}`));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(data);
  });

  return {
    start,
    // Stops reading until the next start(), thumbnail() or grab().
    pause() {
      if (paused) return;
      paused = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      latest = null;
      child?.kill("SIGKILL");
    },
    get running() { return Boolean(child); },
    // For the movement watch: a 32 x 18 grey thumbnail of the live picture.
    async thumbnail() {
      const frame = await live({ wait: 3_000 });
      return frame ? thumbnail(frame.data) : null;
    },
    // For the Breathing Wear finder: full-size PNGs, as is and "soft" (shrunk to 960 wide and
    // blown back up; Nanit's finder misses the raw frame in dim warm light but finds the soft one).
    async grab() {
      const frame = await live();
      if (!frame) return null;
      const [soft, raw] = await Promise.all([
        encode(frame.data, ["-vf", `scale=960:-2:flags=bilinear,scale=${WIDTH}:${HEIGHT}:flags=bilinear`, "-c:v", "png"]),
        encode(frame.data, ["-c:v", "png"]),
      ]);
      return { width: WIDTH, height: HEIGHT, infrared: infrared(frame.data), soft, raw };
    },
    stop() { stopped = true; if (retryTimer) clearTimeout(retryTimer); child?.kill("SIGKILL"); },
  };
}
