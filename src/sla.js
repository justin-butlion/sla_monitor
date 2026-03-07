const db = require('./db');

/**
 * Get the channel config effective at message time (for deciding if message is in scope).
 * Returns { channel_id, sla_hours, effective_from } or null.
 */
async function getConfigForMessage(teamId, channelId, messageTs) {
  return db.getConfigForChannelAtTime(teamId, channelId, messageTs);
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
  const { channel: channelId, ts: messageTs, user: senderUserId, text, bot_id: botId } = message;
  if (!channelId || !messageTs) return;

  const config = await getConfigForMessage(teamId, channelId, messageTs);
  if (!config) return;

  const senderId = botId || senderUserId;
  if (!senderId) return;

  if (!botId) {
    const external = await isSenderExternal(client, senderUserId, teamId);
    if (!external) return;
  }

  const sentAt = new Date(db.parseSlackTs(messageTs) * 1000);
  const snippet = (text || '').slice(0, 500);
  await db.addPendingMessage(teamId, {
    channelId,
    messageTs,
    senderUserId: senderId,
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
  const pending = await db.getPendingByChannelAndTs(teamId, channelId, threadTs);
  if (!pending) return;
  if (!replyUserId) return;
  const isExternal = await isSenderExternal(client, replyUserId, teamId);
  if (!isExternal) {
    await db.removePendingMessage(teamId, channelId, threadTs);
  }
}

/**
 * Run SLA check: for each pending message, if past SLA and no workspace reply, move to failed_messages.
 */
async function runSLACheck(client, teamId) {
  const pending = await db.getPendingMessages(teamId);
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
      await db.addFailedMessage(teamId, {
        channelId: channel_id,
        messageTs: message_ts,
        senderUserId: sender_user_id,
        sentAt: sent_at,
        messageSnippet: message_snippet,
      });
      await db.removePendingMessage(teamId, channel_id, message_ts);

      const notifyConfig = await db.getNotifyConfigForChannel(teamId, channel_id);
      const userIds = (notifyConfig?.notify_user_ids || []).filter(
        (id) => typeof id === 'string' && id.trim().length > 0
      );
      if (userIds.length === 0) {
        console.log('runSLACheck: message failed SLA in channel', channel_id, ', no notify users configured.');
      } else {
        console.log('runSLACheck: sending failure DM to', userIds.length, 'user(s) for channel', channel_id);
        let permalink = null;
        try {
          const res = await client.chat.getPermalink({ channel: channel_id, message_ts });
          permalink = res?.permalink || null;
        } catch {
          // continue without link
        }
        const channelDisplay = notifyConfig.channel_name ? `#${notifyConfig.channel_name}` : 'this channel';
        const text = permalink
          ? `A message in ${channelDisplay} has failed the SLA. View the message here: ${permalink}`
          : `A message in ${channelDisplay} has failed the SLA.`;
        const blocks = permalink
          ? [{ type: 'section', text: { type: 'mrkdwn', text: `A message in ${channelDisplay} has failed the SLA. View the message <${permalink}|here>.` } }]
          : [{ type: 'section', text: { type: 'mrkdwn', text: `A message in ${channelDisplay} has failed the SLA.` } }];
        for (const userId of userIds) {
          try {
            const openRes = await client.conversations.open({ users: userId });
            const dmChannelId = openRes?.channel?.id;
            if (!dmChannelId) {
              console.error('runSLACheck: conversations.open did not return channel for user', userId, 'response:', openRes);
              continue;
            }
            await client.chat.postMessage({ channel: dmChannelId, text, blocks });
          } catch (err) {
            const slackError = err.data?.error ?? err.data ?? err.message;
            console.error('runSLACheck: failed to DM notify user', userId, err.message, 'Slack error:', slackError);
          }
        }
      }
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
