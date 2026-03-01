const { App } = require('@slack/bolt');
const db = require('./db');
const { registerEventHandlers } = require('./events');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

registerEventHandlers(app);

async function main() {
  await db.initSchema();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`SLA Monitor app is running on port ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
