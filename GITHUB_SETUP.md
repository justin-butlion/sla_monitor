# GitHub repository setup

Follow these steps to put your Slack SLA Monitor app on GitHub.

---

## 1. Install Git (if needed)

- Download: https://git-scm.com/download/win  
- Run the installer (defaults are fine).  
- Restart your terminal or Cursor after installing.

---

## 2. Create the repository on GitHub

1. Go to **https://github.com/new**
2. **Repository name:** e.g. `slack-sla-monitor` (or any name you like)
3. **Description:** optional, e.g. "Slack app to monitor channel SLAs"
4. Choose **Public**
5. **Do not** check "Add a README", "Add .gitignore", or "Choose a license" (you already have these in the project)
6. Click **Create repository**

---

## 3. Run these commands in your project folder

Open a terminal in your project (e.g. `c:\Cursor Projects\Slack SLA App`) and run the commands below.  
Replace `YOUR_USERNAME` and `YOUR_REPO_NAME` with your GitHub username and the repo name you chose.

```bash
# Initialize git
git init

# Stage all files (.env is ignored and will NOT be committed)
git add .

# Check what will be committed (confirm .env is not listed)
git status

# First commit
git commit -m "Initial commit: Slack SLA Monitor app"

# Add your GitHub repo as the remote (use your URL)
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

# Rename branch to main (if needed) and push
git branch -M main
git push -u origin main
```

**Example** if your username is `jdoe` and repo name is `slack-sla-monitor`:

```bash
git remote add origin https://github.com/jdoe/slack-sla-monitor.git
```

---

## 4. Confirm

- Refresh your repo page on GitHub. You should see all project files.
- **You should NOT see** `.env` or `node_modules/` (they are in `.gitignore`).

---

## 5. Later: connect Render to this repo

When you deploy on Render, connect the **Web Service** to this GitHub repository so it can auto-deploy on push.
