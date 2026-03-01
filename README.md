# Slack SLA Monitor

A Slack app that monitors selected channels for Service Level Agreement (SLA) compliance: your team must reply within a set number of hours to messages from people outside your workspace.

## How it works

- You add channels to monitor and set an SLA (e.g. 12 hours).
- The app tracks messages from users outside your workspace (guests or Slack Connect external orgs) in those channels.
- If a workspace member replies in the thread within the SLA window, the message **passes**. Otherwise it **fails** and appears in "Messages that failed the SLA" in the app.
- Only messages sent **after** a channel is added are checked. Changing the SLA only affects **new** messages.

## Setup

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an existing one).
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**:
   - `app_home:read`, `app_home:write`
   - `channels:history`, `channels:read`
   - `groups:history`, `groups:read` (if you monitor private channels)
   - `users:read`
   - `chat:write` (optional; for notifications)
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).
4. Under **Basic Information**, copy the **Signing Secret**.

### 2. Enable Events and Interactivity

- **Event Subscriptions**: Turn on, set Request URL to `https://<your-host>/slack/events` (after you deploy).
- Subscribe to **Bot events**: `app_home_opened`, `message.channels`, `message.groups`.
- **Interactivity**: Turn on, set Request URL to the same `https://<your-host>/slack/events`.

### 3. App Home

- Under **App Home**, enable **Home Tab** and ensure "Allow users to send Slash commands and messages from the messages tab" is as you like. The app will publish its UI when users open the Home tab.

### 4. Local run (optional)

```bash
cp .env.example .env
# Edit .env: set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, DATABASE_URL (e.g. local PostgreSQL)
npm install
npm start
```

For local development with Events API you need a public URL (e.g. [ngrok](https://ngrok.com)) and set that as the Request URL in Slack.

## Environment variables

| Variable | Description |
| -------- | ----------- |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing Secret from app settings |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Optional; default 3000 |

## Deploy to Render

1. **PostgreSQL**: In Render, create a **PostgreSQL** instance. Note the connection URL (Render will expose it as `DATABASE_URL` when linked).
2. **Web Service**: New **Web Service**, connect your GitHub repo.
   - Build: `npm install`
   - Start: `npm start`
   - Attach the PostgreSQL instance (so `DATABASE_URL` is set).
   - Add env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`.
3. After deploy, copy the service URL (e.g. `https://<name>.onrender.com`).
4. In Slack app settings, set **Event Subscriptions** and **Interactivity** Request URL to `https://<name>.onrender.com/slack/events`.
5. Reinstall the app to your workspace if needed. Invite the app to each channel you want to monitor.

## GitHub

- Do not commit `.env` or any file containing tokens. Use `.env.example` as a template.
- Initialize and push to your repo:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git remote add origin https://github.com/<username>/<repo>.git
  git push -u origin main
  ```

## License

MIT
