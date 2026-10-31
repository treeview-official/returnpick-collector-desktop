import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Collector } from './controller.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke-test');
const probe = process.argv.includes('--probe-list');
const collectTest = process.argv.includes('--collect-test');
if (smoke || probe || collectTest) app.setPath('userData', path.join(app.getPath('temp'), `returnpick-electron-test-${process.pid}`));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, collector, closing = false;
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); } });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  collector = new Collector(app.getPath('userData'), path.join(app.getPath('documents'), 'ReturnPick', 'exports'));
  window = new BrowserWindow({
    width: 1080, height: 820, minWidth: 880, minHeight: 710,
    title: 'ReturnPick Collector', backgroundColor: '#f5f7fb',
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  const uiPath = path.join(here, 'ui', 'index.html');
  const diagnostics = app.isPackaged ? path.join(app.getPath('temp'), 'ReturnPick-Collector-tests') : path.join(app.getAppPath(), '.runtime');
  const trusted = event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || fileURLToPath(event.senderFrame.url) !== uiPath) throw new Error('허용되지 않은 요청입니다.');
  };
  const handle = (name, fn) => ipcMain.handle('collector:' + name, async (event, ...args) => { trusted(event); return fn(...args); });
  handle('state', () => collector.snapshot());
  handle('settings', value => collector.settings(value));
  handle('start', resume => collector.start(resume === true));
  handle('stop', () => collector.stop());
  handle('showBrowser', () => collector.showBrowser());
  handle('openFolder', async () => { fs.mkdirSync(collector.outputDir, { recursive: true }); const error = await shell.openPath(collector.outputDir); if (error) throw new Error(error); });
  handle('selectFolder', async () => {
    if (collector.running) throw new Error('수집을 중지한 뒤 폴더를 변경해주세요.');
    const result = await dialog.showOpenDialog(window, { title: '수집 결과 저장 폴더', defaultPath: collector.outputDir, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? collector.snapshot() : collector.settings({ outputDir: result.filePaths[0] });
  });
  collector.on('change', value => { if (!window.isDestroyed()) window.webContents.send('collector:change', value); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', async event => {
    if (closing) return;
    event.preventDefault();
    if (collector.running && !smoke && !probe && !collectTest) {
      const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['계속 수집', '저장 후 종료'], defaultId: 0, cancelId: 0, title: '수집 중입니다', message: '수집을 중지하고 현재 결과를 저장한 뒤 종료할까요?' });
      if (answer.response === 0) return;
    }
    closing = true;
    await collector.shutdown();
    app.quit();
  });
  await window.loadFile(uiPath);
  app.on('window-all-closed', () => app.quit());
  if (collectTest) {
    const source = process.argv.includes('--goldbox') ? 'goldbox' : 'returns';
    const outputDir = path.join(diagnostics, 'live-test', source);
    collector.settings({ sourceKey: source, outputDir });
    const stopAfter = state => { if (state.phase === 'running' && state.actions >= 2) collector.stop(); };
    collector.on('change', stopAfter);
    try {
      collector.start(false); await collector.running;
      if (!collector.state.count || collector.state.phase !== 'partial') throw new Error('실제 수집/중지 테스트 실패: ' + JSON.stringify(collector.snapshot()));
      const firstCount = collector.state.count;
      collector.start(true); await collector.running;
      if (collector.state.count < firstCount || collector.state.phase !== 'partial') throw new Error('이어 수집 테스트 실패');
      const result = { source, firstCount, resumedCount: collector.state.count, status: collector.state.phase, outputDir };
      fs.writeFileSync(path.join(diagnostics, `collect-test-${source}.json`), JSON.stringify(result, null, 2));
      console.log('COLLECT_TEST_OK', JSON.stringify(result));
      await collector.shutdown(); app.exit(0);
    } catch (error) { console.error(error.message); await collector.shutdown(); app.exit(1); }
  }
  if (smoke) {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.collector.state();
        return { bridge: !!state.config, buttons: document.querySelectorAll('button').length, title: document.title, nodeBlocked: typeof require === 'undefined', overflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      if (!result.bridge || !result.nodeBlocked || result.overflow) throw new Error(JSON.stringify(result));
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      let png;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { png = await window.webContents.capturePage(); break; }
        catch (error) { if (attempt === 3) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
      }
      const folder = diagnostics; fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'smoke.png'), png.toPNG());
      fs.writeFileSync(path.join(folder, 'smoke.json'), JSON.stringify(result, null, 2));
      console.log('SMOKE_OK', JSON.stringify(result));
      await collector.shutdown(); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  }
  if (probe) {
    const { ElectronPage } = await import('./electron-browser.mjs');
    const { SOURCE_URL } = await import(process.argv.includes('--goldbox') ? './engine/goldbox.mjs' : './engine/browser.mjs');
    const page = new ElectronPage({ sourceUrl: SOURCE_URL });
    try {
      await page.goto(SOURCE_URL);
      await new Promise(resolve => setTimeout(resolve, 4000));
      const result = { url: page.url(), cards: await page.locator(process.argv.includes('--goldbox') ? '.m-product-item' : '.product-unit-info__title').count(), text: (await page.locator('body').textContent()).slice(0, 400) };
      console.log('PROBE', JSON.stringify(result));
      fs.mkdirSync(diagnostics, { recursive: true });
      fs.writeFileSync(path.join(diagnostics, 'probe.json'), JSON.stringify(result, null, 2));
      await page.close(); await collector.shutdown(); app.exit(result.cards ? 0 : 2);
    } catch (error) {
      console.error(error);
      if (!page.isClosed()) {
        fs.mkdirSync(diagnostics, { recursive: true });
        fs.writeFileSync(path.join(diagnostics, 'probe-error.png'), (await page.window.webContents.capturePage()).toPNG());
        console.log('PROBE_ERROR_PAGE', JSON.stringify({ url: page.url(), text: (await page.locator('body').textContent()).slice(0, 400) }));
      }
      await collector.shutdown(); app.exit(1);
    }
  }
}
