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
        text: '• Add channels to monitor and set an SLA (hours to reply).\n• The app tracks messages from people outside your workspace in those channels.\n• If a workspace member replies in the thread within the SLA window, the message passes; otherwise it fails.\n• View and manage failed messages below; remove or copy links as needed.',
      },
    },
  ];
}

/** Channels for monitoring: list + Add channel button */
function channelsSectionBlocks(channels, client) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Channels for monitoring', emoji: true } },
  ];
  if (channels.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No channels added yet._' },
    });
  } else {
    for (const ch of channels) {
      const channelName = ch.channel_name || ch.channel_id;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*#${channelName}* — SLA: ${ch.sla_hours} hour${ch.sla_hours !== 1 ? 's' : ''}`,
        },
        accessory: {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Edit SLA' }, action_id: 'edit_sla', value: ch.channel_id },
            { type: 'button', text: { type: 'plain_text', text: 'Remove' }, action_id: 'remove_channel', value: ch.channel_id },
          ],
        },
      });
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

/** Failed messages table as section blocks */
function failedMessagesBlocks(failed, userNames) {
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
      accessory: {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Copy link' }, action_id: 'copy_failed_link', value: String(row.id) },
          { type: 'button', text: { type: 'plain_text', text: 'Remove' }, action_id: 'remove_failed', value: String(row.id) },
        ],
      },
    });
  }
  return blocks;
}

/** Resolve channel names for display */
async function resolveChannelNames(client, channelIds) {
  const names = {};
  for (const id of channelIds) {
    try {
      const r = await client.conversations.info({ channel: id });
      names[id] = r.channel?.name || id;
    } catch {
      names[id] = id;
    }
  }
  return names;
}

/** Resolve user display names for failed messages */
async function resolveUserNames(client, userIds) {
  const names = {};
  for (const id of userIds) {
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
  const configs = await db.getCurrentChannelConfigs();
  const channelIds = configs.map((c) => c.channel_id);
  const channelNames = await resolveChannelNames(client, channelIds);
  const channelsWithNames = configs.map((c) => ({ ...c, channel_name: channelNames[c.channel_id] }));

  const failed = await db.getFailedMessages();
  const userIds = [...new Set(failed.map((f) => f.sender_user_id))];
  const userNames = await resolveUserNames(client, userIds);

  return [
    ...howToUseBlocks(),
    { type: 'divider' },
    ...channelsSectionBlocks(channelsWithNames, client),
    { type: 'divider' },
    ...failedMessagesBlocks(failed, userNames),
  ];
}

/** Modal: Add channel */
function addChannelModal() {
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
    ],
  };
}

/** Modal: Edit SLA (channel_id in private_metadata) */
function editSlaModal(channelId, currentSla) {
  return {
    type: 'modal',
    callback_id: 'edit_sla_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Edit SLA' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
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
  removeChannelConfirmModal,
  removeFailedConfirmModal,
};
