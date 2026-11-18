// Stand-in for @pushforge/builder: records what would have been pushed.
export const pushed = [];
export async function buildPushHTTPRequest({ privateJWK, subscription, message }) {
  if (!privateJWK?.d || !privateJWK?.x) throw new Error('bad VAPID key');
  if (!message.adminContact) throw new Error('adminContact required');
  pushed.push({ endpoint: subscription.endpoint, payload: message.payload, options: message.options });
  return { endpoint: subscription.endpoint, headers: new Headers({ TTL: '60' }), body: new ArrayBuffer(8) };
}
