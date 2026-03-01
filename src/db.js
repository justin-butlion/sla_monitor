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
      CREATE TABLE IF NOT EXISTS channel_configs (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(32) NOT NULL,
        sla_hours INTEGER NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        removed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_channel_configs_channel_effective
        ON channel_configs (channel_id, effective_from DESC);
      CREATE INDEX IF NOT EXISTS idx_channel_configs_removed
        ON channel_configs (channel_id) WHERE removed_at IS NULL;

      CREATE TABLE IF NOT EXISTS pending_messages (
        channel_id VARCHAR(32) NOT NULL,
        message_ts VARCHAR(32) NOT NULL,
        sender_user_id VARCHAR(32) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL,
        sla_hours INTEGER NOT NULL,
        message_snippet TEXT,
        PRIMARY KEY (channel_id, message_ts)
      );

      CREATE TABLE IF NOT EXISTS failed_messages (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(32) NOT NULL,
        message_ts VARCHAR(32) NOT NULL,
        sender_user_id VARCHAR(32) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL,
        message_snippet TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

/** Current monitored channels: latest config per channel where removed_at IS NULL */
async function getCurrentChannelConfigs() {
  const result = await getPool().query(`
    WITH latest AS (
      SELECT DISTINCT ON (channel_id) id, channel_id, sla_hours, effective_from
      FROM channel_configs
      WHERE removed_at IS NULL
      ORDER BY channel_id, effective_from DESC
    )
    SELECT * FROM latest ORDER BY effective_from DESC
  `);
  return result.rows;
}

/** Config effective for a channel at a given time (for SLA resolution) */
async function getConfigForChannelAtTime(channelId, messageTs) {
  const ts = typeof messageTs === 'string' ? parseSlackTs(messageTs) : messageTs;
  const result = await getPool().query(
    `SELECT channel_id, sla_hours, effective_from
     FROM channel_configs
     WHERE channel_id = $1 AND effective_from <= $2::timestamptz AND removed_at IS NULL
     ORDER BY effective_from DESC
     LIMIT 1`,
    [channelId, new Date(ts * 1000)]
  );
  return result.rows[0] || null;
}

function parseSlackTs(ts) {
  const parts = String(ts).split('.');
  return parseInt(parts[0], 10) + (parts[1] ? parseInt(parts[1].slice(0, 6), 10) / 1e6 : 0);
}

/** Add a new channel (or new config row) */
async function addChannelConfig(channelId, slaHours) {
  await getPool().query(
    `INSERT INTO channel_configs (channel_id, sla_hours, effective_from)
     VALUES ($1, $2, NOW())`,
    [channelId, slaHours]
  );
}

/** Edit SLA: insert new row so only new messages use new SLA */
async function addChannelConfigRow(channelId, slaHours) {
  await addChannelConfig(channelId, slaHours);
}

/** Stop monitoring: set removed_at on the latest config for this channel */
async function removeChannel(channelId) {
  await getPool().query(
    `UPDATE channel_configs
     SET removed_at = NOW()
     WHERE id = (
       SELECT id FROM channel_configs
       WHERE channel_id = $1 AND removed_at IS NULL
       ORDER BY effective_from DESC
       LIMIT 1
     )`,
    [channelId]
  );
}

async function addPendingMessage({ channelId, messageTs, senderUserId, sentAt, slaHours, messageSnippet }) {
  await getPool().query(
    `INSERT INTO pending_messages (channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id, message_ts) DO NOTHING`,
    [channelId, messageTs, senderUserId, sentAt, slaHours, messageSnippet || '']
  );
}

async function removePendingMessage(channelId, messageTs) {
  await getPool().query(
    `DELETE FROM pending_messages WHERE channel_id = $1 AND message_ts = $2`,
    [channelId, messageTs]
  );
}

async function getPendingMessages() {
  const result = await getPool().query(
    `SELECT channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet
     FROM pending_messages`
  );
  return result.rows;
}

async function addFailedMessage({ channelId, messageTs, senderUserId, sentAt, messageSnippet }) {
  const result = await getPool().query(
    `INSERT INTO failed_messages (channel_id, message_ts, sender_user_id, sent_at, message_snippet)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [channelId, messageTs, senderUserId, sentAt, messageSnippet || '']
  );
  return result.rows[0].id;
}

async function getFailedMessages() {
  const result = await getPool().query(
    `SELECT id, channel_id, message_ts, sender_user_id, sent_at, message_snippet, created_at
     FROM failed_messages
     ORDER BY sent_at DESC`
  );
  return result.rows;
}

async function getFailedMessageById(id) {
  const result = await getPool().query(
    `SELECT id, channel_id, message_ts, sender_user_id, sent_at, message_snippet
     FROM failed_messages WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function removeFailedMessage(id) {
  await getPool().query(`DELETE FROM failed_messages WHERE id = $1`, [id]);
}

async function getPendingByChannelAndTs(channelId, messageTs) {
  const result = await getPool().query(
    `SELECT channel_id, message_ts, sender_user_id, sent_at, sla_hours, message_snippet
     FROM pending_messages WHERE channel_id = $1 AND message_ts = $2`,
    [channelId, messageTs]
  );
  return result.rows[0] || null;
}

module.exports = {
  getPool,
  initSchema,
  getCurrentChannelConfigs,
  getConfigForChannelAtTime,
  addChannelConfig,
  addChannelConfigRow,
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
