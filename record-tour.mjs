// Records the tour of Jev Reviewer that the README embeds.
//
// Playwright drives the real app against the real TypeSafe API, so every answer, highlight and
// count in the video is what a reviewer gets. The video is silent; captions carry the story.
//
// Usage, with the app served (npm start, or the live site):
//   node record-tour.mjs [https://jevreviewer.xera.ac]
//
// It writes documentation/tour.mp4 (1920 by 1080) and documentation/tour.gif, needs Google
// Chrome and ffmpeg, and asks about 25 questions (about two cents).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dir = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "http://localhost:8787/";
const outDir = resolve(dir, "documentation");
const raw = resolve(dir, "build/tour");
const frames = resolve(raw, "frames");
const mp4 = resolve(outDir, "tour.mp4");
const gif = resolve(outDir, "tour.gif");
await rm(raw, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await mkdir(outDir, { recursive: true });

// Headless recordings have no pointer and no voice, so the page gets a drawn pointer and a
// caption line. Both ignore events and are not part of the app.
function overlays() {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(28,24,21,.42);border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4);pointer-events:none;z-index:2147483647;transition:transform .12s";
    const cap = document.createElement("div");
    cap.style.cssText = "position:fixed;left:24px;bottom:62px;max-width:min(640px,52vw);padding:12px 18px;border-radius:14px;background:rgba(28,24,21,.9);color:#f6f1ea;font:500 18px/1.38 Geist,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;transition:opacity .3s;pointer-events:none;z-index:2147483646";
    document.documentElement.append(dot, cap);
    addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.65)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
    window.__caption = (text) => { if (text) cap.textContent = text; cap.style.opacity = text ? "1" : "0"; };
  });
}

// A 1280 by 720 layout drawn at device scale 1.5 is 1920 by 1080 real pixels, and a screencast
// keeps them, where Playwright's own recorder would scale CSS pixels up and blur every label.
const browser = await chromium.launch({ channel: "chrome", args: ["--force-device-scale-factor=1.5", "--window-size=1280,807"] });
const context = await browser.newContext({ viewport: null, colorScheme: "light", acceptDownloads: true });
await context.addInitScript(overlays);

try {
  // Warm the caches (pdf.js from the CDN, fonts, the sample files) on a throwaway page, then
  // forget the study it saved, so the tour starts on an empty desk.
  const warm = await context.newPage();
  await warm.goto(url);
  await warm.locator("#sampleBtn").click();
  await warm.waitForFunction(() => /^Ready/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
  await warm.goto(new URL("favicon.svg", url).href); // same site, no app: its storage connection is closed
  await warm.evaluate(
    () =>
      new Promise((done) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase("jev-reviewer");
        req.onsuccess = req.onerror = req.onblocked = done;
      }),
  );
  await warm.close();

  const page = await context.newPage();
  const beat = (ms) => page.waitForTimeout(ms);
  const warnings = [];
  const warn = (message) => { warnings.push(message); console.warn(`record-tour: WARNING ${message}`); };
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#model").textContent); // the app has started
  await page.waitForTimeout(500);
  if (await page.locator(".place").count()) warn("the desk is not empty at the start: an old project was kept");
  const size = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio].join(" "));
  if (size !== "1280 720 1.5") throw new Error(`record-tour: the page is ${size} (width, height, scale), not 1280 720 1.5; adjust --window-size`);

  // Chrome sends a frame whenever the page repaints, stamped with the time it was drawn, and the
  // next one only after this one is acknowledged.
  const shots = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = resolve(frames, `${String(shots.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    shots.push({ file, at: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const clock = () => Date.now() / 1000;
  const start = clock();

  let pointer = { x: 640, y: 380 };
  async function glide(x, y, ms = 650) {
    const steps = Math.max(2, Math.round(ms / 25));
    const from = pointer;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const ease = t * t * (3 - 2 * t);
      await page.mouse.move(from.x + (x - from.x) * ease, from.y + (y - from.y) * ease);
      await beat(ms / steps);
    }
    pointer = { x, y };
  }
  async function press(locator, hold = 200) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error("record-tour: tried to press something that is not on screen");
    await glide(box.x + box.width / 2, box.y + box.height / 2);
    await beat(hold);
    await page.mouse.down();
    await beat(90);
    await page.mouse.up();
  }
  const caption = (text) => page.evaluate((t) => window.__caption(t), text);
  const status = () => page.locator("#status").innerText();
  async function ask(question) {
    await press(page.locator("#q"));
    await page.keyboard.type(question, { delay: 42 });
    await beat(350);
    await press(page.getByRole("button", { name: "Ask", exact: true }));
    await page.waitForFunction(() => /^Answered|failed/.test(document.querySelector("#status").textContent), null, { timeout: 60000 })
      .catch(() => warn(`"${question}" never came back`));
  }
  const entry = (n) => page.locator(".entry").nth(n);

  // 1. An empty desk
  await page.mouse.move(pointer.x, pointer.y);
  await beat(500);
  await caption("Jev Reviewer answers systematic review questions from a trial report and its supplements, quoting the lines it finds.");
  await beat(3600);

  // 2. The sample study: an article PDF and two Word supplements
  await press(page.locator("#sampleBtn"));
  await page.waitForFunction(() => /^Ready/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
  await caption("Open the paper with its supplements, as PDF, Word, Excel, PowerPoint, web pages or text. The sample adds the analysis plan and CONSORT checklist, both Word files.");
  await beat(1200);
  await glide(260, 84);
  await beat(2800);

  // 3. A question whose best answer is in the analysis plan
  await caption("Ask in plain words.");
  const gifFrom = clock();
  await ask("What is the inclusion criterion for age?");
  await beat(400);
  await caption("Each answer is a quote with its file and place. Jev only points at lines; nothing is rewritten.");
  if (!(await entry(0).locator(".ex__where").first().innerText()).includes("sap")) warn("the age question's best quote is not from the analysis plan");
  await beat(3400);
  await press(entry(0).locator(".ex").nth(2));
  await caption("Quotes from the article are highlighted on its page.");
  await beat(3000);
  const gifTo = clock();

  // 4. Table rows keep their label
  await ask("baseline characteristics for age");
  await caption("A table answer keeps its row label, and all the rows that answer it.");
  const baseline = await entry(1).locator(".ex__text").first().innerText();
  if (!/Mean \(SD\)/.test(baseline) && !/age was 55\.6/.test(baseline)) warn(`baseline age came back as: ${baseline.slice(0, 80)}`);
  const tableQuote = entry(1).locator(".ex", { hasText: "Median (IQR)" });
  if (await tableQuote.count()) await press(tableQuote.first());
  else warn("no Table 1 quote for baseline age");
  await beat(3800);

  // 5. A whole extraction form from a questions file
  await caption("A questions file runs a whole extraction form at once.");
  const chooser = page.waitForEvent("filechooser");
  await press(page.locator("#fileBtn"));
  await (await chooser).setFiles(resolve(dir, "docs/samples/questions-template.csv"));
  await beat(900);
  await press(page.locator("#runBtn"));
  await page.waitForFunction(() => /reported in/.test(document.querySelector("#status").textContent), null, { timeout: 120000 })
    .catch(() => warn("the questions file never finished"));
  const batch = await status();
  await caption(`${batch.split(" · ")[0]}, for about a cent.`);
  if (!/^18 of 18 reported/.test(batch)) warn(`the template run reported: ${batch}`);
  await beat(1200);
  await page.locator(".results").evaluate((el) => el.scrollTo({ top: el.scrollHeight * 0.45, behavior: "smooth" }));
  await beat(2600);
  await page.locator(".results").evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  await beat(2400);

  // 6. Honest about what is missing
  await ask("What was the dose of metformin?");
  await caption("When the files do not report something, it says so.");
  if (!/Not found/.test(await page.locator(".entry").last().locator(".verdict").innerText())) warn("metformin was not reported as not found");
  await beat(3200);

  // 7. The extraction sheet
  await caption("Export the sheet: one row per quote, with file, page and score.");
  const download = page.waitForEvent("download");
  await page.locator(".results").evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
  await press(page.locator("#exportBtn"));
  const csvFile = resolve(raw, "extraction.csv");
  await (await download).saveAs(csvFile);
  const rows = readFileSync(csvFile, "utf8").trim().split(/\r?\n/).length - 1;
  if (rows < 20) warn(`the exported sheet has only ${rows} rows`);
  await beat(2800);

  // 8. Projects, kept in this browser
  await caption("Each study sits in a project with its files and answers, all kept in this browser. Nothing is uploaded.");
  await press(page.locator("#projectsBtn"));
  const studies = await page.locator(".study-row .name-field").evaluateAll((fields) => fields.map((f) => f.value));
  if (!studies.includes("Johnson 2026")) warn(`the projects sheet lists ${JSON.stringify(studies)}, not the sample study`);
  await beat(1400);
  const row = await page.locator(".study-row").first().boundingBox();
  if (row) await glide(row.x + row.width * 0.35, row.y + row.height / 2);
  await beat(1800);
  await caption("A project's export puts every study's answers in one sheet.");
  const projectExport = await page.locator(".proj__head .link").first().boundingBox();
  if (projectExport) await glide(projectExport.x + projectExport.width / 2, projectExport.y + projectExport.height / 2);
  await beat(3000);
  await press(page.locator("#libraryClose"));
  await beat(400);

  // 9. Dark theme
  await caption("A dark theme is one click away. Voice questions work in Chrome and Edge.");
  await press(page.locator("#themeBtn"));
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "dark") warn("the theme toggle did not switch to dark");
  await beat(900);
  await glide(1105, 104);
  await beat(3200);
  await caption("");
  await beat(700);
  const end = clock();
  await cdp.send("Page.stopScreencast");

  // ------------------------------------------------------------------ Encode
  // Each frame is shown until the next one arrives: frames come at a variable rate, and
  // resampling them to a fixed rate would duplicate frames unevenly.
  const run = [shots.filter((s) => s.at <= start).at(-1), ...shots.filter((s) => s.at > start && s.at < end)].filter(Boolean);
  const list = ["ffconcat version 1.0"];
  run.forEach((shot, k) => {
    const stop = k + 1 < run.length ? run[k + 1].at : end;
    list.push(`file '${shot.file}'`, `duration ${(stop - Math.max(shot.at, start)).toFixed(4)}`);
  });
  list.push(`file '${run.at(-1).file}'`); // the concat demuxer ignores the last duration unless its file is repeated
  const listFile = resolve(raw, "frames.txt");
  await writeFile(listFile, list.join("\n") + "\n");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
    "-fps_mode", "vfr",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-movflags", "+faststart", "-an", mp4,
  ], { stdio: ["ignore", "ignore", "inherit"] });

  // The gif is the first question only: a whole tour at gif frame rates runs to megabytes.
  const gifStart = gifFrom - start;
  const gifLength = Math.min(12, gifTo - gifFrom);
  const palette = resolve(raw, "palette.png");
  const gifFilter = "fps=10,scale=720:-1:flags=lanczos";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", gifStart.toFixed(2), "-t", gifLength.toFixed(2), "-i", mp4, "-vf", `${gifFilter},palettegen=stats_mode=diff:max_colors=128`, palette], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", gifStart.toFixed(2), "-t", gifLength.toFixed(2), "-i", mp4, "-i", palette, "-lavfi", `${gifFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, gif], { stdio: ["ignore", "ignore", "inherit"] });

  await rm(frames, { recursive: true, force: true });
  await rm(listFile, { force: true });
  await writeFile(resolve(raw, "take.json"), JSON.stringify({ url, seconds: end - start, frames: shots.length, gif: { start: gifStart, length: gifLength }, warnings }, null, 2));
  const mb = (path) => (statSync(path).size / 1e6).toFixed(1);
  console.log(`record-tour: tour.mp4 ${(end - start).toFixed(1)}s ${mb(mp4)} MB from ${shots.length} frames, tour.gif ${gifLength.toFixed(1)}s ${mb(gif)} MB, ${warnings.length} warnings`);
  if (warnings.length) process.exitCode = 1;
} finally {
  await browser.close();
}
