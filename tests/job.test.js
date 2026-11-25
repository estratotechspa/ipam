'use strict';

const { run } = require('../src/job');

describe('run', () => {
  it('resuelve a 0 en exito', async () => {
    await expect(run()).resolves.toBe(0);
  });
});
