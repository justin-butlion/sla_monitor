const db = require('./db');
const https = require('https');
const { URL } = require('url');

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

/**
 * Run pre-SLA alert check: for each pending message, send alerts before SLA deadline according to channel_alert_configs.
 */
async function runAlertCheck(client, teamId) {
  const pending = await db.getPendingMessages(teamId);
  const now = new Date();
  const configCache = {};
  const alertsCache = {};

  for (const row of pending) {
    const { channel_id, message_ts, sent_at, sla_hours, message_snippet } = row;
    // Compute SLA deadline from stored sla_hours on pending row
    const deadline = new Date(new Date(sent_at).getTime() + sla_hours * 60 * 60 * 1000);
    if (now >= deadline) continue;

    const key = `${teamId}-${channel_id}`;
    let alerts = alertsCache[key];
    if (!alerts) {
      alerts = await db.getChannelAlertConfigs(teamId, channel_id);
      alertsCache[key] = alerts;
    }
    if (!alerts || alerts.length === 0) continue;

    for (const alert of alerts) {
      const offset = alert.alert_offset_minutes;
      if (!offset || offset <= 0) continue;
      const alertTime = new Date(deadline.getTime() - offset * 60 * 1000);
      if (now < alertTime || now >= deadline) continue;
      // avoid duplicates
      // eslint-disable-next-line no-await-in-loop
      const alreadySent = await db.hasAlertBeenSent(teamId, channel_id, message_ts, offset);
      if (alreadySent) continue;

      const methods = alert.notify_methods || {};
      const dmUserIds = Array.isArray(methods.dm_user_ids) ? methods.dm_user_ids : [];
      const emails = Array.isArray(methods.emails) ? methods.emails : [];
      const webhooks = Array.isArray(methods.webhooks) ? methods.webhooks : [];
      if (dmUserIds.length === 0 && emails.length === 0 && webhooks.length === 0) continue;

      let permalink = null;
      try {
        const res = await client.chat.getPermalink({ channel: channel_id, message_ts });
        permalink = res?.permalink || null;
      } catch {
        // continue without link
      }
      const remainingMs = deadline.getTime() - now.getTime();
      const remainingMinutes = Math.max(1, Math.round(remainingMs / (60 * 1000)));
      const channelConfigKey = `${teamId}-${channel_id}`;
      let channelConfig = configCache[channelConfigKey];
      if (!channelConfig) {
        channelConfig = await db.getNotifyConfigForChannel(teamId, channel_id);
        configCache[channelConfigKey] = channelConfig;
      }
      const channelDisplay = channelConfig.channel_name ? `#${channelConfig.channel_name}` : 'this channel';

      const text = permalink
        ? `A message in ${channelDisplay} is approaching its SLA. Approximately ${remainingMinutes} minute(s) remain before it fails. View the message here: ${permalink}`
        : `A message in ${channelDisplay} is approaching its SLA. Approximately ${remainingMinutes} minute(s) remain before it fails.`;
      const blocks = permalink
        ? [{ type: 'section', text: { type: 'mrkdwn', text: `A message in ${channelDisplay} is approaching its SLA. Approximately ${remainingMinutes} minute(s) remain before it fails. View the message <${permalink}|here>.` } }]
        : [{ type: 'section', text: { type: 'mrkdwn', text: `A message in ${channelDisplay} is approaching its SLA. Approximately ${remainingMinutes} minute(s) remain before it fails.` } }];

      // Slack DMs
      for (const userId of dmUserIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const openRes = await client.conversations.open({ users: userId });
          const dmChannelId = openRes?.channel?.id;
          if (!dmChannelId) {
            // eslint-disable-next-line no-console
            console.error('runAlertCheck: conversations.open did not return channel for user', userId, 'response:', openRes);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          await client.chat.postMessage({ channel: dmChannelId, text, blocks });
        } catch (err) {
          const slackError = err.data?.error ?? err.data ?? err.message;
          // eslint-disable-next-line no-console
          console.error('runAlertCheck: failed to DM alert user', userId, err.message, 'Slack error:', slackError);
        }
      }

      // Email + webhooks are stubs for now; they can be implemented by integrating an email provider or HTTP client.
      if (emails.length > 0) {
        // eslint-disable-next-line no-console
        console.log('runAlertCheck: email alerts requested for', emails.length, 'recipient(s)', 'for channel', channel_id);
      }
      if (webhooks.length > 0) {
        const payload = {
          type: 'pre_sla_alert',
          team_id: teamId,
          channel_id,
          channel_name: channelConfig.channel_name || null,
          message_ts,
          permalink: permalink || null,
          sla_hours,
          deadline: deadline.toISOString(),
          alert_offset_minutes: offset,
          remaining_minutes: remainingMinutes,
          message: message_snippet || '',
        };
        for (const urlString of webhooks) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await postJsonWebhook(urlString, payload);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('runAlertCheck: webhook POST failed for', urlString, err.message);
          }
        }
      }

      // Mark this alert as sent to avoid duplicates
      // eslint-disable-next-line no-await-in-loop
      await db.markAlertSent(teamId, channel_id, message_ts, offset);
    }
  }
}

function postJsonWebhook(urlString, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      reject(new Error('Invalid webhook URL'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Unsupported webhook protocol'));
      return;
    }
    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      // drain response
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy(new Error('Webhook request timed out'));
    });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

module.exports = {
  getConfigForMessage,
  isSenderExternal,
  maybeRecordPendingMessage,
  maybeMarkReplied,
  runSLACheck,
  runAlertCheck,
  postJsonWebhook,
};
