import { HubClient } from '/Users/jerrysmith/Desktop/WeVibe/tests/lib/hub-client.ts';
import { generateTestIdentity } from '/Users/jerrysmith/Desktop/WeVibe/tests/lib/identity.js';

const identity = generateTestIdentity();
const client = new HubClient();

try {
  console.log('CLIENT IDENTITY PUBKEY:', identity.pubkeyHex);
  console.log('CLIENT BASE URL:', client.baseUrl);
  const result = await client.createOrg(
    'probe-' + Date.now(),
    'probe',
    'test',
    identity.pubkeyHex, // pkMod placeholder
    '', // encEnvelope placeholder
    '', // searchEnvelope placeholder
    '', // modEnvelope placeholder
    { fee_type: 'free' },
    identity,
  );
  console.log('SUCCESS:', JSON.stringify(result));
} catch (e: any) {
  console.log('FAILED:', e.message);
  console.log('STATUS:', e.status);
  console.log('BODY:', e.body);
}
