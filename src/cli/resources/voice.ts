// `call` needs no approval: the host, not the agent, picks who the link speaks as, and sends it only to that
// person's DM.
import { TIMEZONE } from '../../config.js';
import { groupCallLive, startOrJoinGroupCall } from '../../modules/voice-call/group/service.js';
import { mintVoiceCall } from '../../modules/voice-call/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'voice',
  plural: 'voice',
  table: 'sessions',
  description: 'Let the person you are talking to call you by voice from their phone.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    call: {
      access: 'open',
      description:
        'Run this when the person asks to call you, start a call, talk by voice, or hop on a call. Add --group when they ask for a group call or a call with several people, from a channel. When a group call is already live in this conversation, this adds the person who asked to it, with or without --group. The host sends a one-time link to their DM (never post or ask for it here); it expires 5 minutes after it is sent. During a call, spoken requests arrive in this conversation as messages marked [Voice call] or [Group voice call], and your replies are read aloud, so open each reply with one to three plain spoken sentences. Everyone in the thread still sees your replies.',
      args: [
        { name: 'group', type: 'boolean', description: 'Start a group call that others in the channel can join.' },
      ],
      examples: ['ncl voice call', 'ncl voice call --group'],
      handler: async (args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Only an agent session can start a voice call.');
        const input = { sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId };
        if (args.group === true || args.group === 'true' || groupCallLive(ctx.sessionId))
          return { group: true, ...(await startOrJoinGroupCall(input)) };
        return mintVoiceCall(input);
      },
      formatHuman: (data) => {
        const { sentTo, expiresAt, group, joined } = data as {
          sentTo: string;
          expiresAt: string;
          group?: boolean;
          joined?: boolean;
        };
        const what = !group ? 'Call link' : joined ? 'Link to join the group call' : 'Group call started; link';
        return `${what} sent to ${sentTo}'s DM; it expires at ${formatLocalTime(expiresAt, TIMEZONE)}. Tell them to check their DM.${group && !joined ? ' Others in this channel join by asking you to add them.' : ''}`;
      },
    },
  },
});
