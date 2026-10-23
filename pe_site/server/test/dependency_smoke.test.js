import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

test('Nodemailer builds order email without SMTP network traffic', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const result = await transport.sendMail({
    from: 'store@example.invalid',
    to: 'customer@example.invalid',
    subject: 'Pink Elephant — Order confirmation',
    text: 'Your order has been received.',
    html: '<p>Your order has been received.</p>',
  });
  const message = JSON.parse(result.message);
  assert.equal(message.subject, 'Pink Elephant — Order confirmation');
  assert.equal(message.to[0].address, 'customer@example.invalid');
  assert.match(message.text, /order has been received/);
  transport.close();
});

test('S3 PutObject serializes image upload without contacting R2', async () => {
  let request;
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    forcePathStyle: true,
    credentials: { accessKeyId: 'TEST_ONLY', secretAccessKey: 'TEST_ONLY' },
    requestHandler: {
      handle: async (req) => {
        request = req;
        return { response: { statusCode: 200, headers: { etag: '"test-etag"' }, body: new Uint8Array() } };
      },
    },
  });
  const result = await client.send(new PutObjectCommand({
    Bucket: 'test-bucket',
    Key: 'inventory/test.png',
    Body: Buffer.from([137, 80, 78, 71]),
    ContentType: 'image/png',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  assert.equal(result.ETag, '"test-etag"');
  assert.equal(request.method, 'PUT');
  assert.match(request.path, /inventory\/test\.png/);
  assert.equal(request.headers['content-type'], 'image/png');
  client.destroy();
});
