# Street Court Teammate Finder — 街場搵隊友

AIDM7450 group project (2 members). A Hong Kong street-basketball teammate finder: an 18-district SVG map of real
LCSD basketball courts, plus pick-up games that can be published, joined and settled. The site publishes people,
**not courts** — it never claims a court has been reserved.

## 1. Live demo

    https://hk-streetball.onrender.com

Hosted on Render's free tier, so an instance that has been idle for about 15 minutes falls asleep and the **first
request takes roughly 10–30 seconds** to wake it. The page you are reading in a browser does not need to be reopened —
just wait for the first response. Data is shared with the local run described below when both point at the same
MongoDB database.

## 2. Run it locally

Requirements: Node.js 20.19 or newer (that is the floor the MongoDB driver 7 declares; developed and tested on
v26.1.0 with npm 11.13.0, and the hosted service runs 24.x) and npm. Only two dependencies are used: Express 5
(`>= 18`) and the official MongoDB driver 7.

    npm install
    node server.js
    # then open http://localhost:3000

Do not open `index.html` by double-clicking it. The map, districts and games are all fetched from the API, and a
`file://` page cannot call them; the server also serves the static files, so `http://localhost:3000` is the only
entry point.

Optional configuration — copy `.env.example` to `.env` and fill in your own values:

    MONGO_URI=mongodb+srv://<db-user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
    MONGO_DB=hk_streetball
    PORT=3000

`server.js` reads `.env` itself (no `dotenv` package). `.env` is **not** part of the submission and must never be
committed or zipped; the repository ships only `.env.example`, whose connection string is a placeholder.

## 3. Two storage modes, and how to tell which one you are in

| | Memory mode (no `MONGO_URI`) | MongoDB mode (valid `MONGO_URI`) |
|---|---|---|
| Startup log | `[store] … → 記憶體示範模式` | `[store] MongoDB 已連線` |
| Page footer text | `模式：記憶體示範（重啟即冇）` | `模式：MongoDB 共享` |
| `GET /api/meta` | `"mode":"memory"` | `"mode":"mongo"` |
| Games survive a restart | no | yes |
| Shared between devices | no | yes |

If the connection string is present but fails (wrong network access, expired password, unreachable host), the server
logs the reason and **falls back to memory mode instead of crashing**, so the site is always demonstrable. Reference
data (18 districts, 243 court records) is read from `data/*.json`; in MongoDB mode it is imported on first start and
then served from the database, and the startup aborts if the two counts disagree.

## 4. Project layout

    index.html  map.js        page 1 — district map, court markers, 18-district bar chart, court panel, game list
    post.html   post.js       page 2 — single-page segmented publish/edit form
    guide.html  guide.js      street-court guide (four tabs)
    guide-data.js             the guide text, diagrams and interface phrases in one place, reused by the court panel
    style.css                 all styling; map colours live here, not in the SVG
    server.js                 Express application, storage layer, validation and business rules
    data/                       districts.json, courts.json (cleaned LCSD export), games.sample.json (demo fixtures)
    tools/seed-demo.js         regenerates data/games.sample.json
    tools/reseed-demo.js       restores individual demo fixtures by game_id (dry run unless --yes)
    hk-districts.svg           the boundary artwork, also inlined into index.html between MAP:START / MAP:END
    .env.example               template only — no credentials

## 5. API

All responses use `{data, meta}` or `{error:{code,message,fields}, meta}`. Public reads need no account. Management
credentials are issued by the server and returned only in the private part of a create response; they are never
included in a public list, never logged, and never stored in a cookie.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meta` | mode, counts, source labels |
| GET | `/api/districts` | district lookup table |
| GET | `/api/courts` | `district_id`/`code`/`q` |
| GET | `/api/courts/{id}` | one court, including publish eligibility |
| GET | `/api/stats/districts` | whole-dataset overview per district; deliberately ignores game filters |
| GET | `/api/games` | `court_id`/`district_id`/`code`/`time_filter`/`date`/`status`/`dataset` |
| GET | `/api/games/{id}` | game detail (still readable after it ends) |
| POST | `/api/games` | create; returns the organiser's private credential |
| PATCH | `/api/games/{id}` | organiser edit with `expected_version`; `court_id` is immutable |
| POST | `/api/games/{id}/confirm` · `/start` · `/end` · `/cancel` | state transitions |
| POST | `/api/games/{id}/signups` | join; returns that participant's own private credential |
| PATCH | `/api/games/{id}/signups/{sid}` | report arrival |
| POST | `/api/games/{id}/signups/{sid}/withdraw` · `/rejoin` | leave / re-check a seat and return |

Authorisation is carried as `Authorization: Bearer <credential>` on those same resource paths, so the separate
`GET …/manage` endpoints suggested in the design contract are not needed and are not implemented. Pagination
(`cursor`/`limit`) and the spatial `bbox` filter are also left out on purpose: the whole reference set is 243 courts,
and the specification warns that a map must not treat the first 30 records as if they were everything — so `/api/courts`
returns the complete filtered list and says so in `meta.scope = "full_dataset"`.

Writes are guarded by rules that the client cannot override: the target size is derived from the format
(3v3 = 6, 4v4 = 8), `now` games take their start time from the server, an event never crosses Hong Kong midnight,
recruitment for a `now` game expires 60 minutes after the organiser's last confirmation, the last seat is allocated
atomically, and `Idempotency-Key` makes a retried submission return the original result instead of taking two seats.

## 6. Demo fixtures

`data/games.sample.json` holds eight games, all flagged `is_demo=true` and labelled 示範資料 in the interface, covering
the situations the specification asks for: recruiting, full, started, withdrawn-and-rejoined, planned, ended, cancelled
and expired. Two of the states are kept on purpose as evidence that terminated events stay readable.

Because a `now` game is only valid for an hour after its confirmation, the server re-anchors the four live demo windows
at boot and on a five-minute tick; that is what keeps the default list non-empty on a free host that restarts
frequently. To repair a fixture that a test signup polluted:

    node tools/seed-demo.js
    node tools/reseed-demo.js            # dry run — prints what differs
    node tools/reseed-demo.js --yes      # restore those game_ids only

Both tools refuse anything that is not a demo fixture, so real records are never touched.

## 7. Data sources and attribution

- Court records: LCSD / data.gov.hk basketball-court facility dataset (`facility-bkbc.json`), processed 2026-11-13 —
  243 records, of which 240 carry usable coordinates and 3 are kept as "to be verified" instead of being dropped.
- District boundaries: Paulkit/HKMap (MIT, exported from a 2013 Google Earth KML), simplified with mapshaper.
  Projection is equirectangular with a `cos(22.35°)` longitude correction; constants are exposed on the SVG root so
  court coordinates land in the same space.
- Two other candidate boundary sources (a LandsD/HAD export, and Natural Earth land clipped over HAD) were measured
  and rejected — see the report. They are not part of the build.
- Unknown values are shown as 未知 / 未經人工核實 and are never displayed as zero, "no", or "closed".

## 8. Known limitations

Management rights are stored per browser (`localStorage`). Clearing site data, switching device, or using private
mode loses the ability to edit a game you created — the site says so instead of pretending otherwise. There is no
push notification; a visible page polls about every 30 seconds and stops when hidden. The hosted service is single
thread, unauthenticated at the network level and rate-limits nothing, which is acceptable for a coursework demo but
would need HTTPS-enforced auth, rate limiting and server-side validation hardening before real use.

## 9. Use of generative AI

AI tooling was used for parts of the code, the wording of interface text, and testing, within what the course allows
for this assignment. The scope, prompts and what was changed by hand are stated in the report; the site footer also
carries this disclosure.
