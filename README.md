# Jev Reviewer

Open a trial report in Chrome together with its supplements, protocol or analysis plan, then ask
for what your systematic review extraction form needs: *inclusion criteria for age*, *baseline
age*, *how many were randomized*, *who funded it*. Ask by voice, by typing, or with a CSV or TXT
file of questions. Every answer is a **verbatim quote** with its file and page (or paragraph),
highlighted where it sits, and the whole sheet exports to CSV.

**Use it at [jevreviewer.xera.ac](https://jevreviewer.xera.ac)** or
[choxos.github.io/jev-reviewer](https://choxos.github.io/jev-reviewer/). No key, no install.

![Asking the sample study for the age inclusion criterion: the best quote comes from the Word analysis plan and is highlighted there](documentation/tour.gif)

<sub>The first question of the tour. [Watch the full 73 second tour](documentation/tour.mp4) at 1080p, silent with captions: a three-file study, a quote from a Word supplement, a Table 1 answer with its row label, an 18-question extraction form in five seconds, a question the files do not answer, the CSV export and the dark theme.</sub>

The model is **Jev** (TypeSafe's System One model, `jev-1.13.0`). Jev never writes text: it
answers typed questions with probabilities. Here it only points at line ids, and code copies the
quote out of the file. Nothing is paraphrased, so nothing can be invented.

![The age question answered from three files, with the analysis plan open at the quote](documentation/screenshot.jpg)

## How it works

```
 files, read in the browser          segment.js, textfile.js            jev.js
 ─────────────────────────────       ─────────────────────────────      ──────────────────────────────────────
 PDF (pdf.js): text with places ──▶  sentences and table rows           pass 1, screen: one request per chunk of
 Word (.docx): paragraphs, tables    running headers dropped            2 or 3 pages of one file, all questions
 text (.txt, .md)                    hyphens rejoined when safe           Choice "which line answers q?" (+ none)
                                     reference lists flagged              Noul   "does this passage answer q?"
                                     ids by file: A001, B001, C001   ─▶ pass 2, verify: per question, the best
                                                                         lines and their neighbors, one Noul each:
                                                                         "does line B129 itself answer q?"
                                                                         code: quotes = lines with Noul ≥ 0.5,
                                                                         adjacent lines merged, table label added
```

* **A study is several files.** The article, its appendix, the protocol, the statistical
  analysis plan: PDF, Word or plain text. Each file gets a letter that starts its line ids, every
  question is asked of every file, and each quote says which file it came from. The sample study
  is a PLoS Medicine trial with its analysis plan and CONSORT checklist, both Word files.
* **Select, don't generate.** Candidate lines come from the files; Jev picks ids; the quote is
  copied verbatim with file, page or paragraph, section, and its place to highlight.
* **Speculative fan-out.** Each screening request carries every question against the same text,
  so the 18-question template costs about a cent and five seconds over three files.
* **Two kinds of judgment.** The screening Choice is relative (which line, if any). The verifying
  Nouls are absolute (does this line answer), which is what multi-row answers such as
  "Mean (SD)" and "Median (IQR)" under "Age" need.
* **Not reported is an answer.** When no line passes, the card says *Not found* (or *Unclear*,
  with the closest lines) instead of guessing. The strip under each question shows, file by file,
  how likely each stretch was to hold the answer; click it to go there.
* **Voice** uses the browser's speech recognition. Each finished phrase becomes a question; a
  small Jev check (`is_request`, 0.59 to 0.98 for questions, about 0.01 for side talk) drops
  chatter such as "hmm let me see". Say **next** or **previous** to step through quotes.

All question texts and thresholds live in [`docs/jev.js`](docs/jev.js), in one place, like the
`constants.js` of [jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser). Both keep
code in control and ask Jev narrow, typed questions; the voice browser acts on partial speech and
drives Playwright, while here the hard part is reading papers well enough that every quote is a
clean sentence or table row.

## Run it on your computer

Requirements: Node 20 or newer. Chrome or Edge for voice.

```bash
git clone https://github.com/choxos/jev-reviewer.git
cd jev-reviewer
cp .env.example .env              # paste your key from https://console.typesafe.ai/keys
npm start                         # http://localhost:8787
npm start -- path/to/paper.pdf    # opens that paper on start
```

The server has no dependencies. It serves the app from `docs/` and relays requests to TypeSafe
with the key from `.env`, so the key never reaches the browser. It listens on `127.0.0.1` only
and refuses requests from origins and hosts it does not know. Open several files at once with
**Choose files**, add more with **Add file**, or drop them on the page.

## The hosted copies

* **https://jevreviewer.xera.ac**: the full app with its relay.
* **https://choxos.github.io/jev-reviewer/**: the same page from GitHub Pages (published from
  `docs/`), sending its questions to the relay on jevreviewer.xera.ac.

Files are read in the browser and never uploaded; only their text and your questions go to
TypeSafe. The TypeSafe API does not accept requests straight from web pages, so both pages go
through `server.js`, which adds a shared TypeSafe key on the server. To keep a public key
affordable, each address can send only so many requests a second (enough for a
batch), and the server stops spending the shared key after `DAILY_TOKEN_BUDGET` input tokens per
day. A visitor who pastes their own key in **Settings** uses their own quota and is not capped.

### Deploying on the server

The layout: a checkout in `<app folder>`, nginx serving
`docs/` directly, and pm2 running the relay on `127.0.0.1:<port>`.

```bash
# as <deploy user>
git clone https://github.com/choxos/jev-reviewer.git <app folder>
cd <app folder>
cp .env.example .env    # set TYPESAFE_API_KEY, PORT=<port>,
                        # ALLOWED_ORIGINS=https://jevreviewer.xera.ac,https://choxos.github.io,
                        # DAILY_TOKEN_BUDGET=<budget>
./deploy/deploy.sh      # npm ci, tests, pm2 start or restart, pm2 save

# once, as root: enable the vhost and get a certificate
sudo bash <app folder>/deploy/install.sh
```

Updates: `cd <app folder> && git pull && ./deploy/deploy.sh`.

## Questions files

* **CSV** with a header: a `question` (or `query`) column, optionally an `id` column.
  [`docs/samples/questions-template.csv`](docs/samples/questions-template.csv) has 18 common
  items (design, age criteria, baseline age and sex, arms, outcomes, follow-up, risk of bias
  items, funding, registration).
* **CSV** without a header: `id,question` rows.
* **TXT**: one question per line; lines starting with `#` are comments.

**Export CSV** writes one row per quote, best first: `study, id, question, verdict, best_score,
file, location, section, excerpt, excerpt_score, line_ids`, where `location` reads `p. 4` in a PDF
and `para. 129` in a Word or text file. A question with nothing found gets one row with an empty
excerpt, so the sheet always has every item.

## Tests, measurements and the tour

```bash
npm install          # dev only: pdfjs-dist for the tests, playwright-core for the tour
npm test             # segmenter, Word and text reading, requests, policy, CSV, server and relay
npm run live         # real API: 9 questions on the sample study (about half a cent)
npm run live -- paper.pdf supplement.docx --questions my-form.csv --debug
npm run tour -- https://jevreviewer.xera.ac   # writes documentation/tour.mp4 and tour.gif
```

Measured on the sample study (a 17-page article PDF, its 12-page analysis plan and its CONSORT
checklist, 712 lines to search) in September 2026:

| run | requests | time | cost |
| --- | --- | --- | --- |
| 1 question | 10 | 1.2 to 2 s | $0.0016 |
| 9 questions | 17 | 2.3 s | $0.0052 |
| 18 questions (template) | 27 | 4.6 s | $0.0101 |

Screening chunks of 12,000 characters gave the same answers as chunks of 7,000 with a third
fewer requests. Across the sample study, the age criterion (the article and the analysis plan's
"18 years and older"), baseline age (text and Table 1 rows), sample size and missing data (the
analysis plan and the article), randomization, primary outcome and funding came back as the top
quotes; the CONSORT checklist item that points to the missing-data paragraph came back too;
"dose of metformin" came back *Not found*. Treat these as spot checks, not a validation study:
check quotes against the files before they enter your review.

The tour is recorded by [`record-tour.mjs`](record-tour.mjs) against the live site, so every
answer in it is one the app gives. Playwright drives Chrome at a device scale of 1.5, which draws
the 1280 by 720 layout with 1920 by 1080 real pixels, and a Chrome screencast saves each frame as
it is painted; ffmpeg joins the frames with their own timing. Headless Chrome has no pointer and
no microphone, so the recorder draws a pointer and captions; voice is mentioned, not shown. It
warns and exits with status 1 when a step does not happen: a question that never comes back, a
best quote from the wrong file, a Table 1 answer without its rows, a template run that is not 18
of 18, or a CSV with too few rows.

## Design

The page follows the design of [game-of-life](https://github.com/choxos/game-of-life): warm oat
paper, one vermilion accent, Instrument Serif for headings, Geist for everything else, pill
controls and a thin data band at the bottom. It follows the system's light or dark
theme until you pick one with the switch in the header. All colors and fonts are tokens in
[`docs/tokens.css`](docs/tokens.css); the fonts are served from `docs/fonts` under the SIL Open
Font License.

## Limits

* Scanned PDFs have no text layer: run OCR first (the app warns when it finds almost no text).
* Figures are images, so their contents are not searched; captions are. Images and equations in
  Word files are skipped too, and old binary `.doc` files are not read (save them as `.docx`).
* PDF text order follows the file's content stream, which is reading order in publisher PDFs
  (checked on single and two-column layouts). Unusual layouts can merge or split sentences.
* English works best. Thresholds were tuned on `jev-1.13.0`; re-check them if you move the
  model version.
* In Chrome, speech recognition sends audio to Google.

## Layout

```
docs/index.html      the page (GitHub Pages serves docs/)
docs/app.js          studies, viewer, highlights, questions by voice, text or file, results, export
docs/segment.js      PDF text and Word or text blocks to sentences and table rows, with places
docs/textfile.js     .docx (zip and WordprocessingML) and .txt or .md files as blocks
docs/jev.js          questions, thresholds, two-pass requests, result policy, CSV in and out
docs/tokens.css      colors, fonts, spacing, motion; docs/styles.css uses only these
docs/theme.js        the light and dark switch
docs/samples/        the sample study (CC BY 4.0) and the questions template
server.js            app server and TypeSafe relay, local or on the server (no dependencies)
deploy/              nginx vhost, deploy and one-time root install scripts for jevreviewer.xera.ac
record-tour.mjs      the tour recorder; documentation/ holds its video, gif and the screenshot
test/                node --test suites and the live check
```

The sample study is Johnson E, Hyde A, Corrick S, et al. (2026) *Effect of a digital
intervention on mental health symptoms in adults with chronic conditions: A three-arm randomized
controlled trial.* PLoS Med 23(8): e1005198,
[doi:10.1371/journal.pmed.1005198](https://doi.org/10.1371/journal.pmed.1005198), with its S1
File (statistical analysis plan) and S1 Checklist (CONSORT 2025, Hopewell and colleagues),
published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

MIT license.
