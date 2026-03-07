const db = require('./db');

function relativeTime(sentAt) {
  const now = new Date();
  const then = new Date(sentAt);
  const diffMs = now - then;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays >= 1) {
    const hours = diffHours % 24;
    return hours > 0 ? `${diffDays} day${diffDays !== 1 ? 's' : ''}, ${hours} hour${hours !== 1 ? 's' : ''} ago` : `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  }
  return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
}

/** How to use section - static bullets */
function howToUseBlocks() {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'How to use', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '1. Add channels to monitor and set an SLA (hours to reply).\n2. The app tracks messages from people outside your workspace in those channels.\n3. Add the SLA Monitor app to the channels you want to monitor.\n4. If a workspace member replies to the message (in thread) within the SLA window, the message passes; otherwise it fails.\n5. View and manage failed messages at the bottom section of this screen.',
      },
    },
  ];
}

/** Channels for monitoring: list + Add channel button (App Home does not allow actions as section accessory). isMemberByChannel: { [channelId]: boolean } - hide "Add app to channel" when true. */
function channelsSectionBlocks(channels, client, isMemberByChannel = {}) {
  const sorted = [...channels].sort((a, b) => {
    const nameA = (a.channel_name || a.channel_id).toLowerCase();
    const nameB = (b.channel_name || b.channel_id).toLowerCase();
    return nameA.localeCompare(nameB);
  });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Channels for monitoring', emoji: true } },
  ];
  if (sorted.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No channels added yet._' },
    });
  } else {
    for (const ch of sorted) {
      const channelName = ch.channel_name || ch.channel_id;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*#${channelName}* — SLA: ${ch.sla_hours} hour${ch.sla_hours !== 1 ? 's' : ''}`,
        },
      });
      const elements = [];
      if (!isMemberByChannel[ch.channel_id]) {
        elements.push({ type: 'button', text: { type: 'plain_text', text: 'Add app to channel' }, action_id: 'invite_app_to_channel', value: ch.channel_id });
      }
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'Edit SLA' }, action_id: 'edit_sla', value: ch.channel_id });
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'Remove' }, action_id: 'remove_channel', value: ch.channel_id });
      blocks.push({ type: 'actions', elements });
    }
  }
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Add channel' }, action_id: 'add_channel', style: 'primary' },
    ],
  });
  return blocks;
}

/** Failed messages table as section blocks; permalinks: failed id -> url (optional, for View message button) */
function failedMessagesBlocks(failed, userNames, permalinks = {}) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Messages that failed the SLA', emoji: true } },
  ];
  if (failed.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No failed messages._' },
    });
    return blocks;
  }
  for (const row of failed) {
    const snippet = (row.message_snippet || '').slice(0, 100);
    const name = userNames[row.sender_user_id] || row.sender_user_id;
    const sent = relativeTime(row.sent_at);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Message:* ${snippet || '_no text_'}\n*Sent by:* ${name}\n*Sent:* ${sent}`,
      },
    });
    const viewUrl = permalinks[row.id];
    const elements = [];
    if (viewUrl) {
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'View message' }, url: viewUrl });
    }
    elements.push(
      { type: 'button', text: { type: 'plain_text', text: 'Copy message URL' }, action_id: 'copy_failed_link', value: String(row.id) },
      { type: 'button', text: { type: 'plain_text', text: 'Remove' }, action_id: 'remove_failed', value: String(row.id) }
    );
    blocks.push({ type: 'actions', elements });
  }
  return blocks;
}

/** Build id -> name map from conversations.list (public + private bot is in); more reliable than info per channel */
async function resolveChannelNamesFromList(client) {
  const names = {};
  const types = ['public_channel', 'private_channel'];
  let cursor = undefined;
  do {
    const r = await client.conversations.list({
      types: types.join(','),
      limit: 200,
      exclude_archived: true,
      cursor,
    });
    const channels = r.channels || [];
    for (const ch of channels) {
      if (ch.id && ch.name) names[ch.id] = ch.name;
    }
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  return names;
}

/** Resolve channel names: use list first, then conversations.info for any missing */
async function resolveChannelNames(client, channelIds) {
  const names = await resolveChannelNamesFromList(client);
  for (const id of channelIds) {
    if (names[id]) continue;
    try {
      const r = await client.conversations.info({ channel: id });
      const name = r.channel?.name;
      if (name) names[id] = name;
      else names[id] = id;
    } catch {
      names[id] = id;
    }
  }
  return names;
}

/** Get whether the bot is a member of each channel (for showing/hiding "Add app to channel" button) */
async function getChannelMembership(client, channelIds) {
  const result = {};
  for (const id of channelIds) {
    try {
      const r = await client.conversations.info({ channel: id });
      result[id] = r.channel?.is_member === true;
    } catch {
      result[id] = false;
    }
  }
  return result;
}

/** Resolve user display names for failed messages (bot IDs shown as "Bot") */
async function resolveUserNames(client, userIds) {
  const names = {};
  for (const id of userIds) {
    if (id && id.startsWith('B')) {
      names[id] = 'Bot';
      continue;
    }
    try {
      const r = await client.users.info({ user: id });
      const u = r.user;
      names[id] = u?.real_name || u?.name || id;
    } catch {
      names[id] = id;
    }
  }
  return names;
}

/** Build full App Home view and return blocks (needs client for API calls) */
async function buildHomeBlocks(client, teamId) {
  const configs = await db.getCurrentChannelConfigs(teamId);
  const channelIds = configs.map((c) => c.channel_id);
  const channelNames = await resolveChannelNames(client, channelIds);
  for (const c of configs) {
    const resolved = channelNames[c.channel_id];
    if (!c.channel_name && resolved && resolved !== c.channel_id) {
      await db.updateChannelName(teamId, c.channel_id, resolved);
      c.channel_name = resolved;
    }
  }
  const channelsWithNames = configs.map((c) => ({ ...c, channel_name: c.channel_name || channelNames[c.channel_id] }));
  const isMemberByChannel = await getChannelMembership(client, channelIds);

  const failed = await db.getFailedMessages(teamId);
  const userIds = [...new Set(failed.map((f) => f.sender_user_id))];
  const userNames = await resolveUserNames(client, userIds);

  const permalinks = {};
  await Promise.all(
    failed.map(async (row) => {
      try {
        const r = await client.chat.getPermalink({ channel: row.channel_id, message_ts: row.message_ts });
        if (r.permalink) permalinks[row.id] = r.permalink;
      } catch {
        // channel may be inaccessible; leave no url for this row
      }
    })
  );

  return [
    ...howToUseBlocks(),
    { type: 'divider' },
    ...channelsSectionBlocks(channelsWithNames, client, isMemberByChannel),
    { type: 'divider' },
    ...failedMessagesBlocks(failed, userNames, permalinks),
  ];
}

/** Modal: Add channel */
function addChannelModal() {
  const includeOption = { value: 'include', text: { type: 'plain_text', text: 'Include messages from bots in the SLA' } };
  return {
    type: 'modal',
    callback_id: 'add_channel_modal',
    title: { type: 'plain_text', text: 'Add channel' },
    submit: { type: 'plain_text', text: 'Add' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'channel_block',
        element: {
          type: 'conversations_select',
          action_id: 'channel_select',
          placeholder: { type: 'plain_text', text: 'Select a channel' },
          filter: { include: ['public', 'private'] },
        },
        label: { type: 'plain_text', text: 'Channel' },
      },
      {
        type: 'input',
        block_id: 'sla_block',
        element: {
          type: 'plain_text_input',
          action_id: 'sla_input',
          placeholder: { type: 'plain_text', text: 'e.g. 12' },
          initial_value: '12',
        },
        label: { type: 'plain_text', text: 'SLA (hours to reply)' },
      },
      {
        type: 'input',
        block_id: 'bot_block',
        element: {
          type: 'checkboxes',
          action_id: 'include_bots',
          options: [includeOption],
          initial_options: [],
        },
        label: { type: 'plain_text', text: 'Include messages from bots' },
      },
    ],
  };
}

/** Modal: Edit SLA (channel_id in private_metadata; channel name shown read-only; includeBotMessages for checkbox state) */
function editSlaModal(channelId, channelName, currentSla, includeBotMessages = false) {
  const displayName = channelName ? `#${channelName}` : channelId;
  const includeOption = { value: 'include', text: { type: 'plain_text', text: 'Include messages from bots in the SLA' } };
  return {
    type: 'modal',
    callback_id: 'edit_sla_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Edit SLA' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Channel:* ${displayName}\n_(Cannot be changed)_`,
        },
      },
      {
        type: 'input',
        block_id: 'sla_block',
        element: {
          type: 'plain_text_input',
          action_id: 'sla_input',
          placeholder: { type: 'plain_text', text: 'e.g. 24' },
          initial_value: String(currentSla),
        },
        label: { type: 'plain_text', text: 'SLA (hours to reply)' },
      },
      {
        type: 'input',
        block_id: 'bot_block',
        element: {
          type: 'checkboxes',
          action_id: 'include_bots',
          options: [includeOption],
          initial_options: includeBotMessages ? [includeOption] : [],
        },
        label: { type: 'plain_text', text: 'Include messages from bots' },
      },
    ],
  };
}

/** Modal: Instructions to add app to channel (with deep link to open channel) */
function inviteAppToChannelModal(channelId, teamId) {
  const openUrl = teamId
    ? `https://slack.com/app_redirect?channel=${channelId}&team=${teamId}`
    : `https://slack.com/app_redirect?channel=${channelId}`;
  return {
    type: 'modal',
    callback_id: 'invite_app_modal',
    title: { type: 'plain_text', text: 'Add app to channel' },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'To add the *SLA Monitor* app to this channel:\n1. Click *Open channel* below.\n2. In the channel, type: `/invite @SLA Monitor`',
        },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Open channel' }, url: openUrl },
        ],
      },
    ],
  };
}

/** Modal: Confirm remove channel */
function removeChannelConfirmModal(channelId) {
  return {
    type: 'modal',
    callback_id: 'remove_channel_confirm_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Stop monitoring?' },
    submit: { type: 'plain_text', text: 'Yes, stop monitoring' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Stop monitoring this channel? Existing pending/failed messages for this channel will remain.',
        },
      },
    ],
  };
}

/** Modal: Confirm remove failed message */
function removeFailedConfirmModal(failedId) {
  return {
    type: 'modal',
    callback_id: 'remove_failed_confirm_modal',
    private_metadata: String(failedId),
    title: { type: 'plain_text', text: 'Remove message?' },
    submit: { type: 'plain_text', text: 'Yes, remove' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Are you sure you want to remove this message from the list?',
        },
      },
    ],
  };
}

module.exports = {
  relativeTime,
  howToUseBlocks,
  channelsSectionBlocks,
  failedMessagesBlocks,
  buildHomeBlocks,
  resolveChannelNames,
  resolveUserNames,
  addChannelModal,
  editSlaModal,
  inviteAppToChannelModal,
  removeChannelConfirmModal,
  removeFailedConfirmModal,
};
