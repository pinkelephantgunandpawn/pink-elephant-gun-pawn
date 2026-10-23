// One-shot R2 write/read/delete verification; no storefront/database access.
// Operator must explicitly set R2_TEST_RUN=YES in a controlled environment.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID, createHash } from 'node:crypto';

if (process.env.R2_TEST_RUN !== 'YES') {
  console.error('Not running: set R2_TEST_RUN=YES explicitly.');
  process.exit(2);
}
for (const key of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME']) {
  if (!process.env[key]) { console.error('Missing R2 setting:', key); process.exit(2); }
}
const key = 'integration-tests/dependency-upgrade/' + randomUUID() + '.txt';
const body = Buffer.from('Pink Elephant isolated R2 dependency upgrade verification. No inventory changed.\n');
const client = new S3Client({
  region: 'auto',
  endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  requestHandler: undefined,
  maxAttempts: 1,
});
let uploaded = false;
try {
  await client.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:key,Body:body,ContentType:'text/plain'}));
  uploaded = true;
  const response = await client.send(new GetObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:key}));
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (createHash('sha256').update(bytes).digest('hex') !== createHash('sha256').update(body).digest('hex')) throw new Error('Uploaded data mismatch');
  console.log('R2 temporary object upload and readback passed.');
} catch (error) {
  console.error('R2 test failed:', error.name || 'unknown');
  process.exitCode = 1;
} finally {
  if (uploaded) {
    try {
      await client.send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:key}));
      console.log('Temporary R2 test object deleted.');
    } catch (error) {
      console.error('Cleanup failed; remove temporary object under integration-tests/dependency-upgrade/ manually.', error.name || 'unknown');
      process.exitCode = 1;
    }
  }
  client.destroy();
}
