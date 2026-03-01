const { WebClient } = require('@slack/web-api');
const db = require('./db');
const sla = require('./sla');

const INTERVAL_MS = 10 * 60 * 1000;

let intervalId;

async function runAllWorkspaces() {
  const teamIds = await db.getAllInstallationTeamIds();
  for (const teamId of teamIds) {
    try {
      const installation = await db.fetchInstallation(teamId);
      const token = installation?.bot?.token;
      if (!token) continue;
      const client = new WebClient(token);
      await sla.runSLACheck(client, teamId);
    } catch (err) {
      console.error(`SLA check error for team ${teamId}:`, err.message);
    }
  }
}

function startScheduler(app) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(runAllWorkspaces, INTERVAL_MS);
  runAllWorkspaces().catch((err) => console.error('Initial SLA run error:', err));
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { startScheduler, stop };
