# Slack SLA Monitor

A Slack app that monitors selected channels for Service Level Agreement (SLA) compliance: your team must reply within a set number of hours to messages from people outside your workspace.

The app supports **multiple workspaces**: each workspace installs the app via OAuth (Add to Slack), and data is isolated per workspace. You can distribute it via the [Slack App Directory](https://slack.com/apps).

## How it works

- You add channels to monitor and set an SLA (e.g. 12 hours).
- The app tracks messages from users outside your workspace (guests or Slack Connect external orgs) in those channels.
- If a workspace member replies in the thread within the SLA window, the message **passes**. Otherwise it **fails** and appears in "Messages that failed the SLA" in the app.
- Only messages sent **after** a channel is added are checked. Changing the SLA only affects **new** messages.

## Setup

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an existing one).
2. Under **OAuth & Permissions**:
   - Add these **Bot Token Scopes**: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `chat:write`.
   - Under **Redirect URLs**, add `https://<your-host>/slack/oauth_redirect` (replace with your deployed URL; for local dev use an ngrok URL).
3. Under **Basic Information**, note:
   - **Signing Secret**
   - **Client ID**
   - **Client Secret** (under App Credentials).

### 2. Enable Events and Interactivity

- **Event Subscriptions**: On; Request URL `https://<your-host>/slack/events`.
- Subscribe to **Bot events**: `app_home_opened`, `message.channels`, `message.groups`.
- **Interactivity**: On; Request URL `https://<your-host>/slack/events`.

### 3. App Home

- Under **App Home**, enable **Home Tab**.

### 4. Install the app (OAuth)

- **Single workspace**: Open `https://<your-host>/slack/install` in a browser and complete “Add to Slack” for your workspace.
- **App Directory**: Use the same install URL; each workspace that adds the app gets its own isolated data. No bot token is stored in env—tokens are stored per workspace in the database after OAuth.

### 5. Local run (optional)

```bash
cp .env.example .env
# Set SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, DATABASE_URL
npm install
npm start
```

Use a public URL (e.g. [ngrok](https://ngrok.com)) for the Request URL and Redirect URL when testing locally.

## Environment variables

| Variable | Description |
| -------- | ----------- |
| `SLACK_SIGNING_SECRET` | Signing Secret from app settings |
| `SLACK_CLIENT_ID` | OAuth Client ID |
| `SLACK_CLIENT_SECRET` | OAuth Client Secret |
| `SLACK_STATE_SECRET` | Secret for OAuth state (optional; defaults to `SLACK_SIGNING_SECRET`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Optional; default 3000 |

## Deploy to Render

1. **PostgreSQL**: Create a **PostgreSQL** instance in Render. Note the connection URL.
2. **Web Service**: New **Web Service**, connect your GitHub repo.
   - Build: `npm install`
   - Start: `npm start`
   - Attach the PostgreSQL instance (so `DATABASE_URL` is set).
   - Add env vars: `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (and optionally `SLACK_STATE_SECRET`).
3. After deploy, set your service URL (e.g. `https://<name>.onrender.com`) in Slack:
   - **Redirect URLs**: `https://<name>.onrender.com/slack/oauth_redirect`
   - **Event Subscriptions** and **Interactivity** Request URL: `https://<name>.onrender.com/slack/events`
4. Install the app: open `https://<name>.onrender.com/slack/install`, complete “Add to Slack”, then use the app Home tab to add channels.

## Migrating from single-workspace (bot token) setup

If you previously used `SLACK_BOT_TOKEN` and have existing data in the database:

1. Add OAuth credentials and redirect URL as above, then deploy.
2. Install the app via `https://<your-host>/slack/install` for the same workspace.
3. Existing rows in `channel_configs`, `pending_messages`, and `failed_messages` may have `team_id` NULL or `LEGACY`. The app only reads rows for workspaces that have an installation; backfill `team_id` with your workspace ID if you need old data to appear (e.g. `UPDATE channel_configs SET team_id = 'T01234' WHERE team_id IS NULL`).

## License

MIT
