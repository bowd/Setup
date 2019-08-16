import { createWriteStream } from 'fs';
import Koa from 'koa';
import koaBody from 'koa-body';
import compress from 'koa-compress';
import Router from 'koa-router';
import { hashFiles, MpcServer } from 'setup-mpc-common';
import meter from 'stream-meter';
import { Address } from 'web3x/address';
import { bufferToHex, randomBuffer, recover } from 'web3x/utils';
import { defaultState } from './default-state';
import { unlinkAsync, writeFileAsync } from './fs-async';

const cors = require('@koa/cors');

// 1GB
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;

export function app(
  server: MpcServer,
  prefix?: string,
  tmpDir: string = '/tmp',
  maxUploadSize: number = MAX_UPLOAD_SIZE
) {
  const router = new Router({ prefix });
  const adminAddress = Address.fromString('0x3a9b2101bff555793b85493b5171451fa00124c8');

  router.get('/', async (ctx: Koa.Context) => {
    ctx.body = 'OK\n';
  });

  router.post('/reset', koaBody(), async (ctx: Koa.Context) => {
    const signature = ctx.get('X-Signature');
    if (!adminAddress.equals(recover('SignMeWithYourPrivateKey', signature))) {
      ctx.status = 401;
      return;
    }
    const settings = {
      ...defaultState(),
      ...ctx.request.body,
    };
    const { startTime, numG1Points, numG2Points, pointsPerTranscript, invalidateAfter, participants } = settings;
    await server.resetState(
      startTime,
      numG1Points,
      numG2Points,
      pointsPerTranscript,
      invalidateAfter,
      participants.map(Address.fromString)
    );
    ctx.body = 'OK\n';
  });

  router.get('/state', async (ctx: Koa.Context) => {
    ctx.body = await server.getState();
  });

  router.patch('/participant/:address', koaBody(), async (ctx: Koa.Context) => {
    const signature = ctx.get('X-Signature');
    const address = Address.fromString(ctx.params.address);
    if (!address.equals(recover(JSON.stringify(ctx.request.body), signature))) {
      ctx.status = 401;
      return;
    }
    try {
      await server.updateParticipant({
        ...ctx.request.body,
        address,
      });
    } catch (err) {
      // This is a "not running" error. Just swallow it as the client need not be concerned with this.
    }
    ctx.status = 200;
  });

  router.get('/data/:address/:num', async (ctx: Koa.Context) => {
    const { address, num } = ctx.params;
    ctx.body = await server.downloadData(Address.fromString(address), num);
  });

  router.put('/data/:address/:num', async (ctx: Koa.Context) => {
    const address = Address.fromString(ctx.params.address);
    const signature = ctx.get('X-Signature');

    // 500, unless we explicitly set it to 200 or something else.
    ctx.status = 500;

    if (!signature) {
      ctx.body = {
        error: 'No X-Signature header.',
      };
      ctx.status = 401;
      return;
    }

    const { participants } = await server.getState();
    const participant = participants.find(p => p.address.equals(address));
    if (!participant || participant.state !== 'RUNNING') {
      ctx.body = {
        error: 'Can only upload to currently running participant.',
      };
      ctx.status = 401;
      return;
    }

    if (+ctx.params.num >= 30) {
      ctx.body = {
        error: 'Transcript number out of range (max 0-29).',
      };
      ctx.status = 401;
      return;
    }

    // Nonce to prevent collison if attacker attempts to upload at same time as valid user.
    // TODO: Probably better to check a signed fixed token to assert user is who they say they are prior to ingesting body.
    // Can lock server to only allow a single upload at a time.
    const nonce = randomBuffer(8).toString('hex');
    const transcriptPath = `${tmpDir}/transcript_${ctx.params.address}_${ctx.params.num}_${nonce}.dat`;
    const signaturePath = `${tmpDir}/transcript_${ctx.params.address}_${ctx.params.num}_${nonce}.sig`;

    try {
      await new Promise((resolve, reject) => {
        const writeStream = createWriteStream(transcriptPath);
        const meterStream = meter(maxUploadSize);
        meterStream.on('error', (err: Error) => {
          ctx.status = 429;
          reject(err);
        });
        writeStream.on('close', resolve);
        ctx.req.on('error', (err: Error) => reject(err));
        ctx.req.pipe(meterStream).pipe(writeStream);
      });

      const hash = await hashFiles([transcriptPath]);
      if (!address.equals(recover(bufferToHex(hash), signature))) {
        ctx.status = 401;
        throw new Error('Body signature does not match X-Signature.');
      }

      await writeFileAsync(signaturePath, signature);

      await server.uploadData(address, +ctx.params.num, transcriptPath, signaturePath);

      ctx.status = 200;
    } catch (err) {
      console.error(err);
      ctx.body = { error: err.message };
      await unlinkAsync(transcriptPath);
      await unlinkAsync(signaturePath);
      return;
    }
  });

  const app = new Koa();
  app.use(compress());
  app.use(cors());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
