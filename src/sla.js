const db = require('./db');

/**
 * Get the channel config effective at message time (for deciding if message is in scope).
 * Returns { channel_id, sla_hours, effective_from } or null.
 */
async function getConfigForMessage(channelId, messageTs) {
  return db.getConfigForChannelAtTime(channelId, messageTs);
}

/**
 * Check if the message sender is "external" (not a full workspace member).
 * Uses users.info; treats guest/restricted or different team_id as external.
 */
async function isSenderExternal(client, userId, teamId) {
  if (!userId) return true;
  try {
    const result = await client.users.info({ user: userId });
    const user = result?.user;
    if (!user) return true;
    if (user.is_bot) return true;
    if (user.team_id && user.team_id !== teamId) return true;
    if (user.is_restricted || user.is_ultra_restricted) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * If the message is in a monitored channel, from an external sender, and after channel was added,
 * record it in pending_messages.
 */
async function maybeRecordPendingMessage(client, teamId, message) {
  const { channel: channelId, ts: messageTs, user: senderUserId, text } = message;
  if (!channelId || !messageTs || !senderUserId) return;

  const config = await getConfigForMessage(channelId, messageTs);
  if (!config) return;

  const external = await isSenderExternal(client, senderUserId, teamId);
  if (!external) return;

  const sentAt = new Date(db.parseSlackTs(messageTs) * 1000);
  const snippet = (text || '').slice(0, 500);
  await db.addPendingMessage({
    channelId,
    messageTs,
    senderUserId,
    sentAt,
    slaHours: config.sla_hours,
    messageSnippet: snippet,
  });
}

/**
 * When a reply is posted, if the parent is pending and the reply is from a workspace member, remove from pending.
 * replyUserId: the user who just posted the reply (from the message event).
 */
async function maybeMarkReplied(client, teamId, channelId, threadTs, replyUserId) {
  const pending = await db.getPendingByChannelAndTs(channelId, threadTs);
  if (!pending) return;
  if (!replyUserId) return;
  const isExternal = await isSenderExternal(client, replyUserId, teamId);
  if (!isExternal) {
    await db.removePendingMessage(channelId, threadTs);
  }
}

/**
 * Run SLA check: for each pending message, if past SLA and no workspace reply, move to failed_messages.
 */
async function runSLACheck(client, teamId) {
  const pending = await db.getPendingMessages();
  const now = new Date();

  for (const row of pending) {
    const { channel_id, message_ts, sent_at, sla_hours, message_snippet, sender_user_id } = row;
    const deadline = new Date(new Date(sent_at).getTime() + sla_hours * 60 * 60 * 1000);
    if (now <= deadline) continue;

    let hasWorkspaceReply = false;
    try {
      const result = await client.conversations.replies({
        channel: channel_id,
        ts: message_ts,
      });
      const messages = result.messages || [];
      for (const msg of messages) {
        if (msg.ts === message_ts) continue;
        if (msg.bot_id) continue;
        if (!msg.user) continue;
        const external = await isSenderExternal(client, msg.user, teamId);
        if (!external) {
          hasWorkspaceReply = true;
          break;
        }
      }
    } catch {
      // Channel may be inaccessible; treat as no reply
    }

    if (!hasWorkspaceReply) {
      await db.addFailedMessage({
        channelId: channel_id,
        messageTs: message_ts,
        senderUserId: sender_user_id,
        sentAt: sent_at,
        messageSnippet: message_snippet,
      });
      await db.removePendingMessage(channel_id, message_ts);
    }
  }
}

module.exports = {
  getConfigForMessage,
  isSenderExternal,
  maybeRecordPendingMessage,
  maybeMarkReplied,
  runSLACheck,
};
