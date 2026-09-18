# Jev Reviewer

Open a trial report in Chrome together with its supplements, protocol, analysis plan or data
tables, then ask for what your systematic review extraction form needs: *inclusion criteria for
age*, *baseline age*, *how many were randomized*, *who funded it*. Ask by voice, by typing, or with
a questions file (CSV, TXT or a spreadsheet). Every answer is a **verbatim quote** with its file
and page, paragraph, row or slide, highlighted where it sits, and the whole sheet exports to CSV.

Files can be PDF, Word (.docx, .doc), Excel (.xlsx, .xls), PowerPoint (.pptx), OpenDocument
(.odt, .ods, .odp), RTF, saved web pages (.html), CSV, TSV, plain text or Markdown. Work is kept
as **projects** that hold **studies**, and studies hold their files and answers, all stored in your
browser: nothing is uploaded or kept on a server.

**Use it at [jevreviewer.xera.ac](https://jevreviewer.xera.ac)** or
[choxos.github.io/jev-reviewer](https://choxos.github.io/jev-reviewer/). No key, no install.

![Asking the sample study for the age inclusion criterion: the best quote comes from the Word analysis plan and is highlighted there](documentation/tour.gif)

<sub>The first question of the tour. [Watch the full tour](documentation/tour.mp4) at 1080p, silent with captions: a three-file study, a quote from a Word supplement, a Table 1 answer with its row label, an 18-question extraction form in five seconds, a question the files do not answer, the CSV export, the projects sheet and the dark theme.</sub>

The model is **Jev** (TypeSafe's System One model, `jev-1.13.0`). Jev never writes text: it
answers typed questions with probabilities. Here it only points at line ids, and code copies the
quote out of the file. Nothing is paraphrased, so nothing can be invented.

![The age question answered from three files, with the analysis plan open at the quote](documentation/screenshot.jpg)

## How it works

```
 files, read in the browser          segment.js                         jev.js
 ─────────────────────────────       ─────────────────────────────      ──────────────────────────────────────
 PDF (pdf.js): text with places ──▶  sentences and table rows           pass 1, screen: one request per chunk of
 Word, OpenDocument, RTF, web        running headers dropped            2 or 3 pages of one file, all questions
   pages, text: paragraphs, tables   hyphens rejoined when safe           Choice "which line answers q?" (+ none)
 Excel, CSV: rows by sheet           reference lists flagged              Noul   "does this passage answer q?"
 PowerPoint: slide by slide          ids by file: A001, B001, C001   ─▶ pass 2, verify: per question, the best
 (textfile.js, office.js)                                                lines and their neighbors, one Noul each:
                                                                         "does line B129 itself answer q?"
                                                                         code: quotes = lines with Noul ≥ 0.5,
                                                                         adjacent lines merged, table label added
```

* **A study is several files.** The article, its appendix, the protocol, the statistical
  analysis plan, the data tables, a conference slide deck. Each file gets a letter that starts its
  line ids, every question is asked of every file, and each quote says which file it came from.
  The sample study is a PLoS Medicine trial with its analysis plan and CONSORT checklist, both
  Word files.
* **Every format gives the same thing: blocks.** Paragraphs, headings and table rows in reading
  order, whatever the file. A spreadsheet row keeps its row number and shows its cells as the
  spreadsheet does (percentages, decimals, dates); a slide's text keeps its slide number. Files
  are read by their content, so a `.doc` that is really RTF or a saved web page still opens. There
  are no libraries for this: `.docx`, `.xlsx`, `.pptx` and OpenDocument files are zip files read
  with the browser's own decompression, `.doc` and `.xls` are read from their binary formats in
  [`docs/office.js`](docs/office.js), and web pages with the browser's HTML parser.
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
* **Projects, studies, files and answers stay in your browser.** A project holds studies; a
  study holds its files, its answers and their highlights. The column on the left lists every
  project with its studies: pick one to open it, add a study or a project there, delete one with
  its × (pressed twice), or fold the column to a rail for more room. Come back later and the
  study you left opens again, at the file you were reading, with its answers. If an improved
  reader splits a file differently, saved quotes are found again by their exact text; one that no
  longer matches word for word stays, greyed, instead of being lost. Any saved answer can be
  deleted with its own × (pressed twice).
* **A project is a review.** Its questions file belongs to the project. **Manage projects** can
  answer those questions in every study at once (each study is asked only what it has not
  answered yet, about a cent a study for 18 questions), then export every study's answers in one
  sheet with the study's name in the first column. Each quote has a **Copy** button that puts it
  on the clipboard with its file and place, ready for an extraction form.
* **Backups.** Everything lives in the browser's IndexedDB ([`docs/library.js`](docs/library.js)),
  on this device, for this site. **Back up** writes a project, or all of them, to one zip file
  with the studies, answers and files ([`docs/backup.js`](docs/backup.js)); **Restore a backup**
  adds them back as new projects, in this browser or another one. The sheet also says how much
  storage the site uses.
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

Files are read in the browser and never uploaded; only their text and your questions go to TypeSafe.
Projects are saved in the browser you use, per site: the two copies keep separate projects, and
clearing the site's data deletes them. The hosted copies count visits with Google Analytics
([`docs/analytics.js`](docs/analytics.js)): page views only, with a fixed page title and address, so
no study name, file address, file or question reaches it. It is not loaded on localhost or in
automated browsers. The TypeSafe API does not accept requests straight from web pages, so both pages
go through `server.js`, which adds a shared TypeSafe key on the server. To keep a public key
affordable, each address can send only so many requests a second (enough for a batch), and the
server stops spending the shared key after `DAILY_TOKEN_BUDGET` input tokens per day. A visitor who
pastes their own key in **Settings** uses their own quota and is not capped.

### Hosting your own copy

`server.js` is the whole back end. Run it with a TypeSafe key in `.env` (see
[`.env.example`](.env.example)) behind any HTTPS reverse proxy, and list the sites allowed to use
it as their relay in `ALLOWED_ORIGINS`.

## Questions files

* **CSV** with a header: a `question` (or `query`) column, optionally an `id` column.
  [`docs/samples/questions-template.csv`](docs/samples/questions-template.csv) has 18 common
  items (design, age criteria, baseline age and sex, arms, outcomes, follow-up, risk of bias
  items, funding, registration).
* **CSV** without a header: `id,question` rows.
* **A spreadsheet** (.xlsx, .xls, .ods, .tsv): its first sheet, read like a CSV, so an extraction
  form kept in Excel loads as it is.
* **TXT**: one question per line; lines starting with `#` are comments.

A questions file is kept with the project, for all its studies; **Manage projects** runs it on
every study at once.

**Export CSV** writes one row per quote, best first: `study, id, question, verdict, best_score,
file, location, section, excerpt, excerpt_score, line_ids`, where `location` reads `p. 4` in a
PDF, `para. 129` in a Word or text file, `row 12` in a spreadsheet and `slide 3` in a slide deck,
and `study` is the study's name. A question with nothing found gets one row with an empty excerpt,
so the sheet always has every item. **Export CSV** on a project in the projects sheet writes the
same sheet for all of its studies at once.

## Tests, measurements and the tour

```bash
npm install          # dev only: pdfjs-dist for the tests, playwright-core for the tour
npm test             # segmenter, every file format, requests, policy, CSV, backups, server and relay
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

The file readers are tested on [`test/fixtures`](test/fixtures): one report, one workbook and one
slide deck, each written by LibreOffice as .docx, .doc, .odt, .rtf, .xlsx, .xls, .ods, .pptx and
.odp (and by macOS as .doc and .rtf), must all give the same blocks, with footnotes, tracked
deletions and field codes left out and numbers shown as their cells show them.

The tour is recorded by [`record-tour.mjs`](record-tour.mjs) against the live site, so every
answer in it is one the app gives. Playwright drives Chrome at a device scale of 1.5, which draws
the 1280 by 720 layout with 1920 by 1080 real pixels, and a Chrome screencast saves each frame as
it is painted; ffmpeg joins the frames with their own timing. Headless Chrome has no pointer and
no microphone, so the recorder draws a pointer and captions; voice is mentioned, not shown. It
warns and exits with status 1 when a step does not happen: a question that never comes back, a
best quote from the wrong file, a Table 1 answer without its rows, a template run that is not 18
of 18, a CSV with too few rows, or a projects sheet without the study.

## Design

The page follows the design of [game-of-life](https://github.com/choxos/game-of-life): warm oat
paper, one vermilion accent, Instrument Serif for headings, Geist for everything else, pill
controls and a thin data band at the bottom. It follows the system's light or dark
theme until you pick one with the switch in the header. All colors and fonts are tokens in
[`docs/tokens.css`](docs/tokens.css); the fonts are served from `docs/fonts` under the SIL Open
Font License.

## Limits

* Scanned PDFs have no text layer: run OCR first (the app warns when it finds almost no text).
* Figures are images, so their contents are not searched; captions are. Images, charts and
  equations in Office files are skipped too, and so are speaker notes.
* Not read: PowerPoint 97-2003 (.ppt), Word and Excel 95 or older, password-protected files
  (save an unprotected copy, or a PDF). A spreadsheet is read up to 5,000 rows. Number formats
  are applied without their literal text, so `54.2 kg` in a cell formatted `0.0 "kg"` reads `54.2`.
* A web page is read from its main content and its first heading on; the Node scripts
  (`npm run live`) read every format but web pages, which need the browser's parser.
* Projects live in one browser on one device. Clearing the site's data, or a private window,
  loses them: download a backup to keep them, or to move them to another browser or site.
* PDF text order follows the file's content stream, which is reading order in publisher PDFs
  (checked on single and two-column layouts). Unusual layouts can merge or split sentences.
* English works best. Thresholds were tuned on `jev-1.13.0`; re-check them if you move the
  model version.
* In Chrome, speech recognition sends audio to Google.

## Layout

```
docs/index.html      the page (GitHub Pages serves docs/)
docs/app.js          projects and studies, viewer, highlights, questions by voice, text or file, export
docs/library.js      projects, studies, files and answers in the browser's IndexedDB
docs/backup.js       backups: projects with their files in one zip, and restoring them
docs/segment.js      PDF text and other files' blocks to sentences and table rows, with places
docs/textfile.js     every format but PDF as blocks: zip-based Office and OpenDocument files,
                     RTF, web pages, CSV and TSV, text and Markdown
docs/office.js       Word 97-2003 (.doc) and Excel 97-2003 (.xls), and spreadsheet number formats
docs/jev.js          questions, thresholds, two-pass requests, result policy, CSV in and out
docs/tokens.css      colors, fonts, spacing, motion; docs/styles.css uses only these
docs/theme.js        the light and dark switch, and the projects column's first state
docs/analytics.js    Google Analytics page views on the hosted copies
docs/samples/        the sample study (CC BY 4.0) and the questions template
server.js            app server and TypeSafe relay, local or on the server (no dependencies)
record-tour.mjs      the tour recorder; documentation/ holds its video, gif and the screenshot
test/                node --test suites, their fixtures, and the live check
```

The sample study is Johnson E, Hyde A, Corrick S, et al. (2026) *Effect of a digital
intervention on mental health symptoms in adults with chronic conditions: A three-arm randomized
controlled trial.* PLoS Med 23(8): e1005198,
[doi:10.1371/journal.pmed.1005198](https://doi.org/10.1371/journal.pmed.1005198), with its S1
File (statistical analysis plan) and S1 Checklist (CONSORT 2025, Hopewell and colleagues),
published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

MIT license.
