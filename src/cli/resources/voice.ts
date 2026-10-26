// `call` needs no approval: the host, not the agent, picks who the link speaks as, and sends it only to that
// person's DM.
import { TIMEZONE } from '../../config.js';
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
        'Run this when the person asks to call you, talk by voice, or hop on a call. The host sends a one-time call link to their DM (never post or ask for it here); it expires 5 minutes after it is sent. During the call their spoken requests arrive in this conversation as messages marked [Voice call], and your replies are read aloud, so open each reply with one to three plain spoken sentences. Everyone in the thread still sees your replies.',
      args: [],
      examples: ['ncl voice call'],
      handler: async (_args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Only an agent session can start a voice call.');
        return mintVoiceCall({ sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId });
      },
      formatHuman: (data) => {
        const { sentTo, expiresAt } = data as { sentTo: string; expiresAt: string };
        return `Call link sent to ${sentTo}'s DM; it expires at ${formatLocalTime(expiresAt, TIMEZONE)}. Tell them to check their DM.`;
      },
    },
  },
});
