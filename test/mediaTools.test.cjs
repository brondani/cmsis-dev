const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('requires approval before installing and reuses available tools', async () => {
  const storagePath = path.join(__dirname, 'mock-media-storage');
  let systemAvailable = false;
  let installed = false;
  let approved = false;
  let prompts = 0;
  let installs = 0;
  const ffmpeg = path.join(storagePath, 'ffmpeg');
  const ffprobe = path.join(storagePath, 'ffprobe');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return { window: {
        showWarningMessage: async () => { prompts += 1; return approved ? 'Install' : undefined; },
        withProgress: async (_options, task) => task()
      }, ProgressLocation: { Notification: 1 } };
    }
    if (request === 'node:fs/promises') {
      return {
        mkdir: async () => {},
        access: async () => { if (!installed) throw new Error('missing binary'); }
      };
    }
    if (request === 'node:child_process') {
      return { spawn: (command, args) => {
        const child = new EventEmitter();
        process.nextTick(() => {
          if (command === 'npm' || command === 'npm.cmd') {
            assert.equal(args[0], 'install');
            installs += 1;
            installed = true;
            child.emit('close', 0);
          } else if (systemAvailable || (installed && [ffmpeg, ffprobe].includes(command))) {
            child.emit('close', 0);
          } else {
            child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
          }
        });
        return child;
      } };
    }
    if (request === path.join(storagePath, 'node_modules', '@ffmpeg-installer/ffmpeg')) return { path: ffmpeg };
    if (request === path.join(storagePath, 'node_modules', '@ffprobe-installer/ffprobe')) return { path: ffprobe };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { ensureMediaTools } = require('../out/workflows/mediaTools');
    assert.equal(await ensureMediaTools(storagePath), undefined);
    assert.equal(installs, 0);
    approved = true;
    assert.deepEqual(await ensureMediaTools(storagePath), { ffmpeg, ffprobe });
    assert.equal(installs, 1);
    assert.deepEqual(await ensureMediaTools(storagePath), { ffmpeg, ffprobe });
    assert.equal(prompts, 2);
    systemAvailable = true;
    assert.deepEqual(await ensureMediaTools(storagePath), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    assert.equal(prompts, 2);
    assert.equal(installs, 1);
  } finally {
    Module._load = originalLoad;
  }
});