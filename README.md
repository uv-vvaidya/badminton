# Badminton Tournament Portal

Tournament site with player registration, group draws, league and knockout stages, and live scoring.

- **Home**: tournament details, countdown, badminton GIF, events, rules, schedule, prizes. Everything is editable from Admin → Settings.
- **Register**: Men / Women (Singles, Doubles, Mixed doubles) and Kids – Boys / Kids – Girls (Singles, Doubles), partner details or "committee will assign", photo, payment screenshot, about the player.
- **Fixtures**: group standings, league matches, knockout bracket, player cards.
- **Live**: courts in play, updated for every viewer as points are scored.
- **Admin**: first-run setup, registrations review, partner pairing, per-event formats, groups (automatic or manual), league generation, knockout generation, match editing, users.

Stack: Node 22, Express, PostgreSQL. Images are stored in Postgres, so no volume is needed. Live updates use Server-Sent Events.

## Deploy on Railway

1. **Push this folder to a GitHub repository** (private is fine).
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick the repository. Railway builds with the included `Dockerfile`.
3. In the same project, choose **+ Create → Database → PostgreSQL**.
4. Open the app service → **Variables** and add:
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (pick it from the reference list) |
   | `SETUP_TOKEN` | a long random string, for example from `openssl rand -hex 24` |
   | `TOURNAMENT_NAME` | optional starting name, e.g. `UV Badminton Open` |
5. Open the app service → **Settings → Networking → Generate Domain**.
6. Wait for the deploy to turn green. The health check is `/healthz`; tables are created on first start.

Alternative without GitHub: install the Railway CLI, run `railway login`, `railway init`, `railway add --database postgres`, set the two variables, then `railway up` from this folder.

## First-time admin setup

1. Open `https://<your-domain>/#admin`.
2. Enter the `SETUP_TOKEN`, tournament name, admin username and a password (10+ characters). This screen only works while no admin exists.
3. Go to **Settings**: tournament name, small heading, tagline, dates, venue, fee, UPI ID, rules, schedule, prizes, which events are open. Upload the home-page GIF and the UPI QR code.
4. Go to **Users** and add logins for officials:
   | Role | Can do |
   |---|---|
   | **Admin** | Everything |
   | **Scorer** | Score any match |
   | **Umpire** | Score matches assigned to them, or claim an unassigned match by starting it |

   Give each login a display name (shown on matches as "Umpire: Ravi K"). Admins can change roles, reset passwords and remove logins.
5. Assign umpires to matches from **Matches → Edit → Umpire** (optional).

## Running the tournament

1. **Registrations**: check each payment screenshot, then **Confirm** or **Reject**. Singles and players who named a partner become entries on confirmation. Under **Needs partner**, tick two players in the same event and **Pair** them.
2. **Event setup**, for each event:
   1. **Match format**: league points per game (11 / 15 / 21), 1 game or best of 3 / 5, score cap. Knockout: top 1–4 from each group qualify, plus its own points, games and cap. Save for one event or all events.
   2. **Groups**: either **Draw groups randomly** with a number of groups, or set each entry's group by hand.
   3. **League matches**: creates a round robin inside each group.
   4. **Knockout**: once league matches are finished, **Generate knockout draw**. Group winners are seeded first, same-group teams are kept apart in the first round where possible, and top seeds get byes when the qualifier count is not 2, 4, 8 or 16. Winners move into the next round automatically.
3. **Scoring** (scorers and umpires sign in at `/#admin`, then land on the **Score** tab):
   1. Pick a match. Umpires see **Assigned to me** first.
   2. Choose who serves first. Starting an unassigned match assigns it to that umpire.
   3. Tap the big panel of the side that won each rally (on a laptop, press **A** or **B**; **U** undoes). Serve moves to the rally winner.
   4. Games and matches end on their own at the configured score (2-point lead, up to the cap).
   5. **End match early** records a retirement; **Walkover** (before the start) records a no-show. Either gives the other side the win.
   6. When a league match finishes, the group's **points table** updates for everyone straight away and is shown on the scorer's screen. Knockout winners move into the next round.
   **Undo** reverses the last point, even after match point. Admins can correct any score with **Edit**.

Standings: 2 points per win, then wins, game difference, point difference, head-to-head.

## Security notes

- Passwords are hashed with bcrypt. Sessions are random tokens stored hashed, in an HttpOnly, SameSite=Lax cookie (Secure on HTTPS).
- State-changing API calls require an `X-Requested-With: fetch` header (CSRF guard). Login, setup and registration are rate limited per IP.
- Uploads are limited in size and checked by file signature (JPG, PNG, GIF, WebP only).
- Payment screenshots and mobile numbers are visible to admins only. Player photos and names are public.
- A strict Content-Security-Policy is sent on every response.
- Set `SETUP_TOKEN` before the first deploy so nobody else can claim the admin account.

## Local development

```bash
cp .env.example .env            # point DATABASE_URL at a local Postgres
npm install
export $(grep -v '^#' .env | xargs) && npm start
npm test                        # tournament logic tests
```
