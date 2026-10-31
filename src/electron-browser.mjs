// Small Electron implementation of the browser operations used by the two list engines.
// Remote pages have no preload, Node access, IPC bridge, or exposed debugging port.
import { BrowserWindow, session } from 'electron';
import { EventEmitter } from 'node:events';

export class Locator {
  constructor(page, steps = []) { this.page = page; this.steps = steps; }
  locator(selector) { return new Locator(this.page, [...this.steps, { selector }]); }
  nth(index) { return new Locator(this.page, [...this.steps, { index }]); }
  last() { return this.nth(-1); }
  getByRole(role, options) { return new Locator(this.page, [...this.steps, { role, name: options.name, exact: options.exact }]); }
  async evaluateAll(fn) {
    return this.page.evaluate(`(() => {
      let nodes = [document];
      for (const step of ${JSON.stringify(this.steps)}) {
        if ('index' in step) nodes = nodes.length ? [nodes.at(step.index)].filter(Boolean) : [];
        else if (step.selector) nodes = nodes.flatMap(node => [...node.querySelectorAll(step.selector)]);
        else nodes = nodes.flatMap(node => [...node.querySelectorAll(step.role === 'button' ? 'button,[role="button"]' : '[role="'+step.role+'"]')]).filter(node => {
          const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim() || [...node.querySelectorAll('img[alt]')].map(image => image.alt).join(' ');
          return step.exact ? label === step.name : label.includes(step.name);
        });
      }
      return (${fn.toString()})(nodes);
    })()`);
  }
  count() { return this.evaluateAll(nodes => nodes.length); }
  textContent() { return this.evaluateAll(nodes => nodes[0]?.textContent || ''); }
  async click() {
    const point = await this.evaluateAll(nodes => {
      const node = nodes[0];
      if (!node || node.disabled) throw new Error('상품 목록 버튼을 누를 수 없습니다.');
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('상품 목록 버튼이 보이지 않습니다.');
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const wc = this.page.window.webContents;
    wc.sendInputEvent({ type: 'mouseMove', ...point });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
}

export class ElectronPage extends EventEmitter {
  constructor({ sourceUrl, onClosed, show = true }) {
    super();
    this.sourceUrl = sourceUrl;
    this.logs = [];
    const browserSession = session.fromPartition('persist:returnpick-coupang');
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    this.window = new BrowserWindow({
      width: 1600, height: 1000, useContentSize: true, show,
      title: 'ReturnPick · 수집 중인 목록', autoHideMenuBar: true,
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, webSecurity: true, devTools: false }
    });
    const wc = this.window.webContents;
    this.window.on('closed', () => { this.emit('closed'); onClosed?.(); });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allow = url => {
      try { const target = new URL(url), source = new URL(sourceUrl); target.hash = ''; source.hash = ''; return target.href === source.href; }
      catch { return false; }
    };
    wc.on('will-navigate', (event, url) => { if (!allow(url)) event.preventDefault(); });
    wc.on('will-redirect', (event, url, _inPlace, mainFrame) => { if (mainFrame && !allow(url)) event.preventDefault(); });
    browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.webContentsId === wc.id && details.resourceType === 'mainFrame' && !allow(details.url) }));
    wc.on('console-message', details => {
      this.logs.push({ level: details?.level, message: details?.message || '' });
      if (this.logs.length > 30) this.logs.shift();
    });
    wc.debugger.attach('1.3');
    const requests = new Map();
    wc.debugger.on('message', async (_event, method, data) => {
      if (method === 'Network.responseReceived') {
        const { response } = data;
        if (/^https:\/\/pages\.coupang\.com\/api\/(products|parts\/)/.test(response.url)) requests.set(data.requestId, response);
      }
      if (method === 'Network.loadingFinished' && requests.has(data.requestId)) {
        const response = requests.get(data.requestId); requests.delete(data.requestId);
        this.emit('response', { url: () => response.url, status: () => response.status, json: async () => {
          const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: data.requestId });
          return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body);
        }});
      }
      if (method === 'Network.loadingFailed' && requests.has(data.requestId)) {
        const response = requests.get(data.requestId); requests.delete(data.requestId);
        this.emit('requestfailed', { url: () => response.url });
      }
    });
    this.ready = wc.debugger.sendCommand('Network.enable');
    this.mouse = { wheel: async (_x, deltaY) => {
      const [width, height] = this.window.getContentSize();
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.floor(width / 2), y: Math.floor(height / 2), deltaX: 0, deltaY });
    }};
  }
  async evaluate(script) {
    if (this.isClosed()) throw new Error('수집 브라우저가 닫혔습니다. 저장된 결과로 이어 수집할 수 있습니다.');
    const result = await this.window.webContents.executeJavaScript(`(async () => { try { return { ok: true, value: await (${script}) }; } catch (error) { return { ok: false, error: error.message }; } })()`);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  locator(selector) { return new Locator(this, [{ selector }]); }
  async goto(url) {
    if (url !== this.sourceUrl) throw new Error('허용되지 않은 목록 주소입니다.');
    const wc = this.window.webContents;
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); wc.removeListener('dom-ready', loaded); error ? reject(error) : resolve(); };
      const loaded = () => finish();
      const timer = setTimeout(() => finish(new Error('목록을 30초 안에 열지 못했습니다. 인터넷 연결과 쿠팡 접근 상태를 확인해주세요.')), 30000);
      wc.once('dom-ready', loaded);
      wc.loadURL(url).catch(error => finish(error));
    });
    await Promise.race([this.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('내장 브라우저 준비 시간이 초과되었습니다.')), 10000))]);
  }
  url() { return this.isClosed() ? '' : this.window.webContents.getURL(); }
  isClosed() { return this.window.isDestroyed(); }
  async close() { if (!this.isClosed()) this.window.destroy(); }
  async setViewportSize({ width, height }) { this.window.setContentSize(width, height); }
  async route() { /* Navigation is guarded in the main process for all requests. */ }
  async unroute() {}
  mainFrame() { return this.window.webContents.mainFrame; }
  show() { if (!this.isClosed()) this.window.show(); }
}

export const helpers = {
  async inspect({ locator }) {
    return locator.evaluateAll(nodes => {
      const node = nodes[0]; if (!node) return '';
      const rect = node.getBoundingClientRect();
      const scroll = node === document.documentElement ? document.scrollingElement : node;
      const client = node === document.documentElement ? window.innerHeight : node.clientHeight;
      return `Box: x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}\nScroll Y: size=${scroll.scrollHeight} client=${client} overflowing=${scroll.scrollHeight > client} top=${scroll.scrollTop}`;
    });
  },
  async snapshot({ page, locator }) {
    return (locator || page.locator('body')).evaluateAll(nodes => nodes.map(node => node.innerText?.slice(0, 500) || '').join('\n'));
  },
  async getLatestLogs({ page }) { return page.logs?.slice(-3) || []; },
  async waitForPageLoad() { /* loadURL waits for did-finish-load. Engines pause again before capture. */ }
};
