import { createHash } from 'crypto';
import moment from 'moment';
import { MpcServer } from 'setup-mpc-common';
import request from 'supertest';
import { Account } from 'web3x/account';
import { bufferToHex, hexToBuffer } from 'web3x/utils';
import { appFactory } from './app';
import { defaultState } from './default-state';
import { createParticipant } from './state/create-participant';

type Mockify<T> = { [P in keyof T]: jest.Mock<any> };

describe('app', () => {
  const account = Account.fromPrivate(
    hexToBuffer('0xf94ac892bbe482ca01cc43cce0f467d63baef67e37428209f8193fdc0e6d9013')
  );
  let app: any;
  let mockServer: Mockify<MpcServer>;

  beforeEach(() => {
    mockServer = {
      getState: jest.fn(),
      resetState: jest.fn(),
      addParticipant: jest.fn(),
      updateParticipant: jest.fn(),
      downloadData: jest.fn(),
      uploadData: jest.fn(),
      ping: jest.fn(),
    };

    const state = defaultState(1234);
    const participant = createParticipant(0, moment(), 0, 1, account.address);
    participant.state = 'RUNNING';
    state.participants.push(participant);
    mockServer.getState.mockResolvedValue(state);

    const mockParticipantSelector = {
      getCurrentBlockHeight: jest.fn(),
    };
    app = appFactory(mockServer as any, account.address, mockParticipantSelector as any, undefined, '/tmp', 32);
  });

  describe('GET /', () => {
    it('should return 200', async () => {
      const response = await request(app.callback())
        .get('/')
        .send();
      expect(response.status).toBe(200);
    });
  });

  describe('PUT /data', () => {
    it('should return 401 with no signature header', async () => {
      const response = await request(app.callback())
        .put(`/data/${account.address}/0`)
        .send();
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/X-Signature/);
    });

    it('should return 401 with transcript number out of range', async () => {
      const response = await request(app.callback())
        .put(`/data/${account.address}/30`)
        .set('X-Signature', 'placeholder')
        .send();
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/out of range/);
    });

    it('should return 401 with bad signature', async () => {
      const body = 'hello world';
      const badSig =
        '0x76195abb935b441f1553b2f6c60d272de5a56391dfcca8cf22399c4cb600dd26188a4f003176ccdf7f314cbe08740bf7414fadef0e74cb42e94745a836e9dd311d';

      const response = await request(app.callback())
        .put(`/data/${account.address}/0`)
        .set('X-Signature', badSig)
        .send(body);
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/does not match X-Signature/);
    });

    it('should return 429 with body length exceeding limit', async () => {
      const body = '000000000000000000000000000000000';

      const response = await request(app.callback())
        .put(`/data/${account.address}/0`)
        .set('X-Signature', 'placeholder')
        .send(body);
      expect(response.status).toBe(429);
      expect(response.body.error).toMatch(/Stream exceeded/);
    });

    it('should return 200 on success', async () => {
      const body = 'hello world';
      const hash = createHash('sha256')
        .update(body)
        .digest();
      const sig = account.sign(bufferToHex(hash));

      const response = await request(app.callback())
        .put(`/data/${account.address}/0`)
        .set('X-Signature', sig.signature)
        .send(body);
      expect(response.status).toBe(200);
    });
  });
});
