const { App } = require('@slack/bolt');
const db = require('./db');
const { registerEventHandlers } = require('./events');
const { startScheduler } = require('./scheduler');

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET || process.env.SLACK_SIGNING_SECRET,
  scopes: [
    'app_home:read',
    'app_home:write',
    'channels:read',
    'groups:read',
    'users:read',
    'chat:write',
  ],
  installationStore: {
    storeInstallation: async (installation) => {
      const teamId = installation.team?.id || installation.enterprise?.id;
      if (!teamId) throw new Error('No team or enterprise id in installation');
      await db.storeInstallation(teamId, installation);
    },
    fetchInstallation: async (installQuery) => {
      const teamId = installQuery.teamId || installQuery.enterpriseId;
      if (!teamId) throw new Error('Missing teamId/enterpriseId in installQuery');
      const installation = await db.fetchInstallation(teamId);
      if (!installation) throw new Error(`No installation found for ${teamId}`);
      return installation;
    },
    deleteInstallation: async (installQuery) => {
      const teamId = installQuery.teamId || installQuery.enterpriseId;
      if (teamId) await db.deleteInstallation(teamId);
    },
  },
  installerOptions: {
    directInstall: true,
  },
});

registerEventHandlers(app);

async function main() {
  await db.initSchema();
  startScheduler(app);
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`SLA Monitor app is running on port ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
