const sla = require('./sla');

const INTERVAL_MS = 10 * 60 * 1000;

let intervalId;
let client;
let teamId;

function start(clientInstance, teamIdFromContext) {
  client = clientInstance;
  teamId = teamIdFromContext;
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(async () => {
    try {
      await sla.runSLACheck(client, teamId);
    } catch (err) {
      console.error('SLA check error:', err);
    }
  }, INTERVAL_MS);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { start, stop };
