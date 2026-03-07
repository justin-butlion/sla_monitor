const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS installations (
        team_id VARCHAR(32) PRIMARY KEY,
        installation JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_configs (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(32) NOT NULL,
        sla_hours INTEGER NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        removed_at TIMESTAMPTZ
      );
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS team_id VARCHAR(32);
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS channel_name VARCHAR(255);
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS include_bot_messages BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS notify_user_ids JSONB DEFAULT '[]';
      CREATE INDEX IF NOT EXISTS idx_channel_configs_team_channel_effective
        ON channel_configs (team_id, channel_id, effective_from DESC);
      CREATE INDEX IF NOT EXISTS idx_channel_configs_removed
        ON channel_configs (team_id, channel_id) WHERE removed_at IS NULL;

      CREATE TABLE IF NOT EXISTS pending_messages (
        channel_id VARCHAR(32) NOT NULL,
        message_ts VARCHAR(32) NOT NULL,
        sender_user_id VARCHAR(32) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL,
        sla_hours INTEGER NOT NULL,
        message_snippet TEXT,
        PRIMARY KEY (channel_id, message_ts)
      );
      ALTER TABLE pending_messages ADD COLUMN IF NOT EXISTS team_id VARCHAR(32);
    `);
    const pendingHasTeam = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_messages' AND column_name = 'team_id'
    `);
    if (pendingHasTeam.rows.length > 0) {
      await client.query(`UPDATE pending_messages SET team_id = COALESCE(team_id, 'LEGACY') WHERE team_id IS NULL`);
      await client.query(`ALTER TABLE pending_messages ALTER COLUMN team_id SET NOT NULL`);
      try {
        await client.query(`ALTER TABLE pending_messages DROP CONSTRAINT pending_messages_pkey`);
        await client.query(`ALTER TABLE pending_messages ADD PRIMARY KEY (team_id, channel_id, message_ts)`);
      } catch (e) {
        if (!/already exists/.test(e.message)) throw e;
      }
    }
    await client.query(`

      CREATE TABLE IF NOT EXISTS failed_messages (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(32) NOT NULL,
        message_ts VARCHAR(32) NOT NULL,
        sender_user_id VARCHAR(32) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL,
        message_snippet TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE failed_messages ADD COLUMN IF NOT EXISTS team_id VARCHAR(32);
      CREATE INDEX IF NOT EXISTS idx_failed_messages_team ON failed_messages (team_id);

    `);
    const tableExists = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_settings'
    `);
    const hasTeamId = tableExists.rows.length > 0 ? await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'team_id'
    `) : { rows: [] };
    if (tableExists.rows.length === 0 || hasTeamId.rows.length === 0) {
      await client.query(`DROP TABLE IF EXISTS app_settings`);
      await client.query(`
        CREATE TABLE app_settings (
          team_id VARCHAR(32) NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (team_id, key)
        )
      `);
    }
  } finally {
    client.release();
  }
}

/** Store OAuth installation (bot token etc.) by team_id */
async function storeInstallation(teamId, installation) {
  await getPool().query(
    `INSERT INTO installations (team_id, installation) VALUES ($1, $2)
     ON CONFLICT (team_id) DO UPDATE SET installation = $2`,
    [teamId, JSON.stringify(installation)]
  );
}

/** Fetch installation for a team (for Bolt and scheduler) */
async function fetchInstallation(teamId) {
  const result = await getPool().query(
    'SELECT installation FROM installations WHERE team_id = $1',
    [teamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return typeof row.installation === 'object' ? row.installation : JSON.parse(row.installation);
}

/** Delete installation (uninstall) */
async function deleteInstallation(teamId) {
  await getPool().query('DELETE FROM installations WHERE team_id = $1', [teamId]);
}

/** All team IDs that have installed the app (for scheduler) */
async function getAllInstallationTeamIds() {
  const result = await getPool().query('SELECT team_id FROM installations');
  return result.rows.map((r) => r.team_id);
}

/** Get app setting (returns null if not set) */
async function getSetting(teamId, key) {
  const result = await getPool().query(
    'SELECT value FROM app_settings WHERE team_id = $1 AND key = $2',
    [teamId, key]
  );
  const row = result.rows[0];
  return row ? row.value : null;
}

/** Set app setting */
async function setSetting(teamId, key, value) {
  await getPool().query(
    `INSERT INTO app_settings (team_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (team_id, key) DO UPDATE SET value = $3`,
    [teamId, key, value]
  );
}

/** Current monitored channels: latest config per channel where removed_at IS NULL */
async function getCurrentChannelConfigs(teamId) {
  const result = await getPool().query(
    `
    WITH latest AS (
      SELECT DISTINCT ON (channel_id) id, channel_id, sla_hours, effective_from, channel_name, include_bot_messages, COALESCE(notify_user_ids, '[]'::jsonb) AS notify_user_ids
      FROM channel_configs
      WHERE team_id = $1 AND removed_at IS NULL
      ORDER BY channel_id, effective_from DESC
    )
    SELECT * FROM latest ORDER BY effective_from DESC
    `,
    [teamId]
  );
  return result.rows;
}

/** Config effective for a channel at a given time (for SLA resolution) */
async function getConfigForChannelAtTime(teamId, channelId, messageTs) {
  const ts = typeof messageTs === 'string' ? parseSlackTs(messageTs) : messageTs;
  const result = await getPool().query(
    `SELECT channel_id, sla_hours, effective_from, include_bot_messages, COALESCE(notify_user_ids, '[]'::jsonb) AS notify_user_ids
     FROM channel_configs
     WHERE team_id = $1 AND channel_id = $2 AND effective_from <= $3::timestamptz AND removed_at IS NULL
     ORDER BY effective_from DESC
     LIMIT 1`,
    [teamId, channelId, new Date(ts * 1000)]
  );
  return result.rows[0] || null;
}

function parseSlackTs(ts) {
  const parts = String(ts).split('.');
  return parseInt(parts[0], 10) + (parts[1] ? parseInt(parts[1].slice(0, 6), 10) / 1e6 : 0);
}

/** Add a new channel (or new config row); channelName, includeBotMessages, notifyUserIds stored; new messages use this config */
async function addChannelConfig(teamId, channelId, slaHours, channelName = null, includeBotMessages = false, notifyUserIds = []) {
  const ids = Array.isArray(notifyUserIds) ? notifyUserIds : [];
  await getPool().query(
    `INSERT INTO channel_configs (team_id, channel_id, sla_hours, effective_from, channel_name, include_bot_messages, notify_user_ids)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6::jsonb)`,
    [teamId, channelId, slaHours, channelName, !!includeBotMessages, JSON.stringify(ids)]
  );
}

/** Edit SLA / bot / notify setting: insert new row so only new messages use new values */
async function addChannelConfigRow(teamId, channelId, slaHours, channelName = null, includeBotMessages = false, notifyUserIds = []) {
  await addChannelConfig(teamId, channelId, slaHours, channelName, includeBotMessages, notifyUserIds);
}

/** Notify config for a channel (notify_user_ids and channel_name from latest config) for sending failure DMs */
async function getNotifyConfigForChannel(teamId, channelId) {
  const result = await getPool().query(
    `SELECT channel_name, COALESCE(notify_user_ids, '[]'::jsonb) AS notify_user_ids
     FROM channel_configs
     WHERE team_id = $1 AND channel_id = $2 AND removed_at IS NULL
     ORDER BY effective_from DESC
     LIMIT 1`,
    [teamId, channelId]
  );
  const row = result.rows[0];
  if (!row) return { channel_name: null, notify_user_ids: [] };
  let ids = row.notify_user_ids;
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = [];
    }
  }
  if (!Array.isArray(ids)) ids = [];
  ids = ids.filter((id) => typeof id === 'string' && id.trim().length > 0);
  return { channel_name: row.channel_name || null, notify_user_ids: ids };
}

/** Update stored channel name for the latest config of this channel (for display) */
async function updateChannelName(teamId, channelId, channelName) {
  await getPool().query(
    `UPDATE channel_configs
     SET channel_name = $3
     WHERE team_id = $1 AND id = (
       SELECT id FROM channel_configs
       WHERE team_id = $1 AND channel_id = $2 AND removed_at IS NULL
       ORDER BY effective_from DESC
       LIMIT 1
     )`,
    [teamId, channelId, channelName]
  );
}

/** Stop monitoring: set removed_at on the latest config for this channel */
async function removeChannel(teamId, channelId) {
  await getPool().query(
    `UPDATE channel_configs
     SET removed_at = NOW()
     WHERE team_id = $1 AND id = (
       SELECT id FROM channel_configs
       WHERE team_id = $1 AND channel_id = $2 AND removed_at IS NULL
       ORDER BY effective_from DESC
       LIMIT 1
     )`,
    [teamId, channelId]
  );
}

async function addPendingMessage(teamId, { channelId, messageTs, senderUserId, sentAt, slaHours, messageSnippet }) {
  await getPool().query(
    `INSERT INTO pending_messages (team_id, channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (team_id, channel_id, message_ts) DO NOTHING`,
    [teamId, channelId, messageTs, senderUserId, sentAt, slaHours, messageSnippet || '']
  );
}

async function removePendingMessage(teamId, channelId, messageTs) {
  await getPool().query(
    `DELETE FROM pending_messages WHERE team_id = $1 AND channel_id = $2 AND message_ts = $3`,
    [teamId, channelId, messageTs]
  );
}

async function getPendingMessages(teamId) {
  const result = await getPool().query(
    `SELECT channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet
     FROM pending_messages WHERE team_id = $1`,
    [teamId]
  );
  return result.rows;
}

async function addFailedMessage(teamId, { channelId, messageTs, senderUserId, sentAt, messageSnippet }) {
  const result = await getPool().query(
    `INSERT INTO failed_messages (team_id, channel_id, message_ts, sender_user_id, sent_at, message_snippet)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [teamId, channelId, messageTs, senderUserId, sentAt, messageSnippet || '']
  );
  return result.rows[0].id;
}

async function getFailedMessages(teamId) {
  const result = await getPool().query(
    `SELECT id, channel_id, message_ts, sender_user_id, sent_at, message_snippet, created_at
     FROM failed_messages WHERE team_id = $1
     ORDER BY sent_at DESC`,
    [teamId]
  );
  return result.rows;
}

async function getFailedMessageById(teamId, id) {
  const result = await getPool().query(
    `SELECT id, channel_id, message_ts, sender_user_id, sent_at, message_snippet
     FROM failed_messages WHERE team_id = $1 AND id = $2`,
    [teamId, id]
  );
  return result.rows[0] || null;
}

async function removeFailedMessage(teamId, id) {
  await getPool().query(
    `DELETE FROM failed_messages WHERE team_id = $1 AND id = $2`,
    [teamId, id]
  );
}

async function getPendingByChannelAndTs(teamId, channelId, messageTs) {
  const result = await getPool().query(
    `SELECT channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet
     FROM pending_messages WHERE team_id = $1 AND channel_id = $2 AND message_ts = $3`,
    [teamId, channelId, messageTs]
  );
  return result.rows[0] || null;
}

module.exports = {
  getPool,
  initSchema,
  storeInstallation,
  fetchInstallation,
  deleteInstallation,
  getAllInstallationTeamIds,
  getSetting,
  setSetting,
  getCurrentChannelConfigs,
  getConfigForChannelAtTime,
  addChannelConfig,
  addChannelConfigRow,
  getNotifyConfigForChannel,
  updateChannelName,
  removeChannel,
  addPendingMessage,
  removePendingMessage,
  getPendingMessages,
  addFailedMessage,
  getFailedMessages,
  getFailedMessageById,
  removeFailedMessage,
  getPendingByChannelAndTs,
  parseSlackTs,
};
