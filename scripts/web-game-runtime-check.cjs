const { app, BrowserWindow, BaseWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const directory = process.argv[2];
const nativeTransitions = !process.argv.includes('--skip-native-transitions');
const nativeMinimize = nativeTransitions && !process.argv.includes('--skip-native-minimize');
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Desktop game check timed out'); app.exit(2); }, 60000);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Condition did not become true');
    await sleep(30);
  }
}
async function fullscreen(window, frame, enabled) {
  if (!nativeTransitions) return;
  console.log(`Fullscreen ${window.getTitle()} ${enabled}`);
  let timer;
  const transition = new Promise((resolve, reject) => {
    window.once(enabled ? 'enter-full-screen' : 'leave-full-screen', resolve);
    timer = setTimeout(() => reject(new Error(`Native fullscreen transition timed out: ${window.getTitle()} ${enabled}`)), 5000);
  });
  try {
    const request = enabled ? 'document.body.requestFullscreen()' : 'document.exitFullscreen()';
    await Promise.all([transition, frame.executeJavaScript(`${request}.then(() => null, error => error.message)`, true)
      .then(error => assert.equal(error, null, `Fullscreen request: ${error}`))]);
  } finally { clearTimeout(timer); }
}
const backgroundSamples = [];
const unsupportedStorageContracts = [
  'Migrating legacy/default iframe saves into the local native private partition',
  'Persisting native game saves after disposing and replacing the view',
];
async function activity(frame, label, milliseconds) {
  const snapshot = () => frame.executeJavaScript('({ frames: game.frames, ticks: game.ticks, visibility: document.visibilityState })');
  const before = await snapshot();
  const started = Date.now();
  await sleep(milliseconds);
  const after = await snapshot();
  const sample = { label, milliseconds: Date.now() - started, frames: after.frames - before.frames, ticks: after.ticks - before.ticks, visibility: after.visibility };
  backgroundSamples.push(sample);
  return sample;
}
function backgroundActivity(visible, hidden) {
  assert.ok(visible.frames >= 2 && visible.ticks >= 2, `${visible.label} advances animation and timers`);
  assert.equal(hidden.visibility, 'hidden', `${hidden.label} reports hidden`);
  assert.ok(hidden.frames <= 1, `${hidden.label} stops continuous animation`);
  assert.ok(hidden.ticks / hidden.milliseconds < visible.ticks / visible.milliseconds / 2, `${hidden.label} throttles timers`);
}
const html = `<!doctype html><head></head><body style="background:#245;color:white"><h1>Shared game</h1><button id="add">Add point</button><canvas width="80" height="80"></canvas><script>
window.game = { id: crypto.randomUUID(), memory: 0, frames: 0, ticks: 0 };
window.addEventListener('keydown', event => { game.lastKey = event.key; });
const context = document.querySelector('canvas').getContext('2d');
const render = () => { game.frames++; context.fillStyle = '#48a'; context.fillRect(0, 0, 80, 80); requestAnimationFrame(render); }; requestAnimationFrame(render);
setInterval(() => { game.ticks++; }, 16);
async function database() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('qa-game', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('save');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
window.save = async (value) => {
  localStorage.setItem('qaScore', String(value));
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('save', 'readwrite');
    transaction.objectStore('save').put(value, 'score');
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  }); db.close();
};
window.readSave = async () => {
  const db = await database();
  const value = await new Promise(resolve => {
    const request = db.transaction('save').objectStore('save').get('score');
    request.onsuccess = () => resolve(request.result ?? null);
  }); db.close();
  return { localStorage: localStorage.getItem('qaScore'), indexedDB: value };
};
document.querySelector('#add').onclick = () => { game.memory++; void save(game.memory); };
</script></body>`;
let server, proxy, games;
app.whenReady().then(async () => {
  try {
    const { WebGamePlayerWindows } = await import(pathToFileURL(path.join(root, 'dist/desktop/web-game-player.js')).href);
    const { createPreviewProxy } = await import(pathToFileURL(path.join(root, 'dist/daemon/preview-proxy.js')).href);
    server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const navigation = [], diagnostics = [];
    proxy = await createPreviewProxy(`http://127.0.0.1:${server.address().port}`, (diagnostic, all) => { diagnostics.push(all ?? (diagnostic ? [diagnostic] : [])); }, { onNavigation: (client, source, path) => navigation.push({ client, source, path }) });
    const url = `${proxy.url}/?__ohmygame_client=runtime-check&__ohmygame_view=editor`;
    const oldPath = path.join(directory, 'old-preview.html');
    await writeFile(oldPath, `<iframe src="${proxy.url}/?__ohmygame_client=old-preview&__ohmygame_view=editor" sandbox="allow-scripts allow-same-origin"></iframe>`);
    const old = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await old.loadFile(oldPath);
    await eventually(async () => await old.webContents.mainFrame.frames[0]?.executeJavaScript('typeof save') === 'function');
    await old.webContents.mainFrame.frames[0].executeJavaScript('save(64)');
    old.destroy();
    const editorPath = path.join(directory, 'editor.html');
    await writeFile(editorPath, '<body style="background:#333;color:white"><h1>Editor</h1></body>');
    const editor = new BrowserWindow({ width: 1000, height: 800, show: true });
    await editor.loadFile(editorPath);
    const hostUrl = pathToFileURL(path.join(root, 'dist/renderer/web-game-host.html')).href;
    games = new WebGamePlayerWindows(() => {}, hostUrl);
    editor.on('resize', () => games.synchronize());
    const layout = { bounds: { x: 250, y: 100, width: 600, height: 500 }, visible: true };
    let resolves = 0;
    const target = async () => { resolves++; return { url: proxy.url, title: 'Shared game check' }; };
    await games.attach('game', 'mount', editor, url, layout, target);
    const native = webContents.getAllWebContents().find(contents => contents.getURL() === hostUrl);
    assert.ok(native, 'Native game WebContents exists');
    const frame = () => native.mainFrame.frames.find(frame => frame.url.startsWith(proxy.url));
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: null, indexedDB: null }, 'Local private native storage is isolated from legacy/default iframe saves');
    await frame().executeJavaScript('save(64)');
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '64', indexedDB: 64 }, 'Native localStorage and IndexedDB saves work within the view lifetime');
    assert.equal(await frame().executeJavaScript('typeof window.ohMyGameDesktop'), 'undefined');
    assert.equal(await native.executeJavaScript('typeof window.ohMyGameDesktop'), 'undefined');
    const identity = await frame().executeJavaScript('game.id');
    console.log(nativeTransitions ? 'Checking native game fullscreen...' : 'Skipping native fullscreen/minimize transitions (--skip-native-transitions).');
    if (nativeTransitions) {
      const withoutGesture = await frame().executeJavaScript('document.body.requestFullscreen().then(() => true, () => false)');
      assert.equal(withoutGesture, false, 'The game needs a user gesture to enter fullscreen');
      assert.equal(editor.isFullScreen(), false);
    }
    await fullscreen(editor, frame(), true);
    await frame().executeJavaScript('game.memory = 42; history.pushState({}, "", "/scene?level=2#boss")');
    await eventually(() => navigation.at(-1)?.path === '/scene?level=2#boss');
    const frameId = frame().frameTreeNodeId;
    const editorExit = nativeTransitions ? new Promise(resolve => editor.once('leave-full-screen', resolve)) : Promise.resolve();
    await games.open('game', { path: '/', viewport: { width: 375, height: 667 } }, target);
    await editorExit;
    await eventually(() => !editor.isFullScreen());
    if (nativeTransitions) console.log('Native editor fullscreen and exit on transfer passed.');
    assert.equal(resolves, 1, 'Opening Play reuses the existing server and game');
    assert.equal(frame().frameTreeNodeId, frameId, 'Opening Play retains the same frame');
    assert.equal(await frame().executeJavaScript('game.id'), identity);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    app.focus({ steal: true });
    native.focus();
    assert.equal(native.focusedFrame?.frameTreeNodeId, frameId, 'Play focuses the game frame');
    await eventually(() => navigation.at(-1)?.source === 'player');
    await frame().executeJavaScript('save(99)');
    await frame().executeJavaScript('setTimeout(() => { throw new Error("QA native game error"); }, 0)');
    await eventually(() => diagnostics.at(-1)?.some(item => item.message.includes('QA native game error') && item.source === 'player'));
    const player = BaseWindow.getAllWindows().find(window => window !== editor);
    assert.ok(player);
    await fullscreen(player, frame(), true);
    await fullscreen(player, frame(), false);
    player.setContentSize(768, 600);
    await eventually(async () => await frame().executeJavaScript('innerWidth') === 768);
    games.layout('game', 'mount', { ...layout, visible: false });
    assert.equal(native.isAudioMuted(), false, 'Editor overlays cannot mute the separate Play window');
    await eventually(async () => await frame().executeJavaScript('document.visibilityState') === 'visible');
    const visiblePlay = await activity(frame(), 'visible Play', 400);
    player.hide();
    await eventually(async () => native.isAudioMuted() && !player.isVisible() && await frame().executeJavaScript('document.visibilityState') === 'hidden');
    await sleep(100);
    backgroundActivity(visiblePlay, await activity(frame(), 'hidden Play', 1200));
    player.show();
    await eventually(async () => !native.isAudioMuted() && await frame().executeJavaScript('document.visibilityState') === 'visible');
    const shownPlay = await activity(frame(), 'shown Play', 400);
    assert.ok(shownPlay.frames >= 2 && shownPlay.ticks >= 2, 'Showing Play resumes animation and timers');
    if (nativeMinimize) {
      player.minimize();
      await eventually(async () => player.isMinimized() && native.isAudioMuted() && await frame().executeJavaScript('document.visibilityState') === 'hidden');
      await sleep(100);
      backgroundActivity(shownPlay, await activity(frame(), 'minimized Play', 1200));
      player.restore();
      await eventually(async () => !player.isMinimized() && !native.isAudioMuted() && await frame().executeJavaScript('document.visibilityState') === 'visible');
    }
    const restoredPlay = await activity(frame(), 'restored Play', 400);
    assert.ok(restoredPlay.frames >= 2 && restoredPlay.ticks >= 2, 'Restoring Play resumes animation and timers');
    assert.equal(frame().frameTreeNodeId, frameId, 'Hide/show and minimize/restore retain the game frame');
    assert.equal(await frame().executeJavaScript('game.id'), identity);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    assert.deepEqual(await frame().executeJavaScript('Array.from(document.querySelector("canvas").getContext("2d").getImageData(0, 0, 1, 1).data)'), [68, 136, 170, 255], 'The child-frame Canvas keeps rendering after restore');
    games.closeProject('game');
    assert.equal(games.state('game').open, false);
    assert.equal(frame().frameTreeNodeId, frameId);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    const ai = new BrowserWindow({ show: false, webPreferences: { partition: 'qa-ai-game', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await ai.loadURL(`${proxy.url}/?__ohmygame_client=ai-check&__ohmygame_view=playtest&ohmygamePlaytest=1`);
    await eventually(async () => await ai.webContents.executeJavaScript('typeof readSave') === 'function');
    assert.deepEqual(await ai.webContents.executeJavaScript('readSave()'), { localStorage: null, indexedDB: null }, 'AI partitions cannot alter human saves');
    ai.destroy();
    await eventually(() => navigation.filter(item => item.client === 'runtime-check').at(-1)?.source === 'editor');
    await eventually(() => diagnostics.at(-1)?.some(item => item.message.includes('QA native game error') && item.source === 'editor'));
    assert.equal(native.isAudioMuted(), true, 'Hidden Preview is muted');
    const hiddenState = await frame().executeJavaScript('document.visibilityState');
    assert.equal(hiddenState, 'hidden', 'Hidden native views report background visibility');
    await sleep(100);
    backgroundActivity(restoredPlay, await activity(frame(), 'hidden Preview', 1200));
    games.layout('game', 'mount', layout);
    await eventually(async () => !native.isAudioMuted() && await frame().executeJavaScript('document.visibilityState') === 'visible');
    const shownPreview = await activity(frame(), 'shown Preview', 400);
    await fullscreen(editor, frame(), true);
    await fullscreen(editor, frame(), false);
    assert.ok(shownPreview.frames >= 2 && shownPreview.ticks >= 2, 'Showing Preview resumes animation and timers');
    assert.equal(frame().frameTreeNodeId, frameId, 'Showing Preview retains the game frame');
    assert.equal(await frame().executeJavaScript('game.id'), identity);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    const image = await games.capture('game');
    assert.ok(image.length > 100, 'Captures the native game itself');
    await games.refresh('game', target, true);
    await eventually(async () => await frame().executeJavaScript('game.id') !== identity);
    assert.notEqual(await frame().executeJavaScript('game.id'), identity, 'An explicit refresh restarts the game');
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    assert.equal(await frame().executeJavaScript('location.pathname + location.search.replace(/([?&])__ohmygame_[^&]+/g, "$1").replace(/[?&]+$/, "") + location.hash'), '/scene?level=2#boss');
    native.forcefullyCrashRenderer();
    await eventually(() => !!games.state('game').error);
    await games.refresh('game', target, true);
    assert.equal(games.state('game').error, undefined, 'Refresh recovers a crashed game process');
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    assert.equal(await frame().executeJavaScript('location.pathname'), '/scene');
    await games.open('game', { path: '/', viewport: { width: 375, height: 667 } }, target);
    games.detach('game', 'mount');
    assert.equal(native.isDestroyed(), false, 'Play survives leaving the project');
    games.closeProject('game');
    await eventually(() => native.isDestroyed());
    assert.equal(native.isDestroyed(), true, 'Closing the last host releases its game WebContents');
    await games.attach('game', 'again', editor, url, layout, target);
    const reloaded = webContents.getAllWebContents().find(contents => contents.getURL() === hostUrl);
    assert.deepEqual(await reloaded.mainFrame.frames[0].executeJavaScript('readSave()'), { localStorage: null, indexedDB: null }, 'A fully replaced local native view starts with empty private storage');
    games.close();
    await eventually(() => reloaded.isDestroyed());
    assert.equal(reloaded.isDestroyed(), true, 'Service shutdown releases game WebContents');
    const transitions = [['fullscreen transitions', nativeTransitions], ['minimize/restore transitions', nativeMinimize]];
    const skippedChecks = transitions.filter(([, enabled]) => !enabled).map(([name]) => 'native ' + name);
    const nativeChecks = transitions.filter(([, enabled]) => enabled).map(([name]) => name);
    console.log(JSON.stringify({ electron: process.versions.electron, skippedChecks, nativeChecks, checks: 'view-lifetime localStorage/IndexedDB saves, legacy/default storage isolation, live frame identity, in-memory state, game frame focus, routing, source/diagnostics, window transfer, resizing, AI storage isolation, native hide/show, visibility/audio, background animation/timers, child-frame Canvas, native capture, reload, renderer crash recovery, project leave, shutdown', unsupportedStorageContracts, hiddenVisibility: hiddenState, backgroundSamples, result: 'passed' }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(deadline);
    games?.close();
    for (const window of BaseWindow.getAllWindows()) window.destroy();
    await proxy?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
