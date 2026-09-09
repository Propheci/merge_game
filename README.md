# Beach Bar Merge

A merge game for the browser. The board is a bar table seen from above.

There is no gravity. The table is flat and slippery, so a drink glides until
the air and the other drinks slow it down. The player pushes a new drink in
from the near edge. Two equal drinks touch and become one larger drink. The
drinks pile up against the far rail and the pile grows back towards the
player. The game ends when a drink stops behind the dashed line.

Every drink is a real vessel: a shot glass, a cup, a tumbler, a beer mug, a
coupe, a pitcher and more. The vessel keeps the same convex outline for the
picture and for the collisions, and it stays upright while it slides.

Bun runs the server, compiles the browser code and holds the leaderboard.

## Commands

```bash
bun install
bun run dev        # build, then serve on http://localhost:3000
bun run start      # same, with minified browser code
bun test           # score and input checks
bun run typecheck
```

## Settings

| Variable                  | Default             | Function                                        |
| ------------------------- | ------------------- | ----------------------------------------------- |
| `PORT`                    | `3000`              | Port of the HTTP server.                        |
| `MERGE_GAME_DB`           | `data/scores.sqlite`| Path of the SQLite file.                        |
| `MERGE_GAME_HSTS`         | off                 | Set to `1` only when the site runs behind HTTPS.|
| `MERGE_GAME_TRUST_PROXY`  | off                 | Set to `1` only behind a proxy that you control.|

## Layout

```
src/shared/   Tier table (names, outlines, points), random generator and
              message shapes. The browser and the server both use these files.
src/client/   Page, styles, vessel drawing and game. Matter.js does the physics.
src/server/   HTTP server, security helpers, score checks, SQLite.
```

## Security

The browser holds the game, so the browser can lie. These rules make a lie
difficult:

- **The server owns the drop sequence.** Each game gets a random seed. The
  browser and the server make the same sequence from that seed. The server can
  therefore replay the sequence and refuse merge counts that the sequence
  cannot supply.
- **The server calculates the score again** from the merge counts. The score
  that the browser sends is only a check value.
- **One session pays for one score.** A session id has 256 random bits, expires
  after one hour, and becomes invalid after the first score.
- **A game needs real time.** The server measures the time itself and refuses a
  game that reports more drops than the time allows.
- **Rate limits** apply to each IP address, for each route.
- **A strict Content Security Policy** (`default-src 'none'`, no inline script
  and no inline style) protects the page. The page builds all text with
  `textContent`, never with `innerHTML`.
- **Fixed file table.** The server maps a small list of public paths to files.
  It never joins a path from a request with a directory name.
- **Parameters in all SQL.** No value from a request goes into SQL text.
- **Limited input.** The server refuses a body that is larger than 4 KB, a wrong
  content type, and a request that a different web site started.

A robot that plays the true game slowly can still get a high score. Only a full
simulation of the physics on the server stops that.
