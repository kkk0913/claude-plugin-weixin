import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInboundForClaude } from '../../src/weixin/inbound.js';
import { MessageType, type WeixinMessage } from '../../src/weixin/types.js';

test('prepareInboundForClaude collects multiple attachment handles', async () => {
  const stored: Array<{ handle: string; media: unknown }> = [];
  const msg = {
    message_id: 1,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    from_user_id: 'user-1',
    to_user_id: 'bot-1',
    client_id: 'client-1',
    context_token: 'ctx-1',
    item_list: [
      {
        type: MessageType.FILE,
        file_item: {
          media: { aes_key: 'a', encrypt_query_param: 'b', encrypt_type: 0 },
          file_name: 'a.pdf',
        },
      },
      {
        type: MessageType.VIDEO,
        video_item: {
          media: { aes_key: 'c', encrypt_query_param: 'd', encrypt_type: 0 },
        },
      },
      {
        type: MessageType.VOICE,
        voice_item: {
          media: { aes_key: 'e', encrypt_query_param: 'f', encrypt_type: 0 },
          text: 'voice note',
        },
      },
    ],
  } as WeixinMessage;

  const payload = await prepareInboundForClaude(msg, {
    inboxDir: '/tmp',
    storeMediaHandle: (handle, media) => {
      stored.push({ handle, media });
    },
  });

  // Voice messages are not stored as attachments (Claude cannot process audio);
  // their transcription is returned as text via extractTextContent instead.
  assert.equal(payload.attachmentFileIds.length, 2);
  assert.equal(stored.length, 2);
  assert.equal(payload.attachmentFileId, payload.attachmentFileIds[0]);
  assert.deepEqual(payload.attachmentNames, ['a.pdf']);
  assert.equal(payload.attachmentName, 'a.pdf');
});
