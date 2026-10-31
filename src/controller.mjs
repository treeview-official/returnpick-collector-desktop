import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { powerSaveBlocker } from 'electron';
import { ElectronPage, helpers } from './electron-browser.mjs';
import * as returns from './engine/browser.mjs';
import * as goldbox from './engine/goldbox.mjs';
import { readJson, writeJson, saveExport } from './storage.mjs';

export const defaults = Object.freeze({ sourceKey: 'returns', intervalMinutes: 60, repeat: false, pauseMs: 3000, scrollPixels: 650 });
export function validateSettings(value, previous = defaults) {
  if (!value || typeof value !== 'object') throw new Error('설정 형식이 올바르지 않습니다.');
  const result = { ...previous };
  if ('sourceKey' in value) {
    if (!['returns', 'goldbox'].includes(value.sourceKey)) throw new Error('수집할 목록을 선택해주세요.');
    result.sourceKey = value.sourceKey;
  }
  if ('intervalMinutes' in value) {
    if (![30, 60].includes(value.intervalMinutes)) throw new Error('반복 주기는 30분 또는 1시간입니다.');
    result.intervalMinutes = value.intervalMinutes;
  }
  if ('repeat' in value) result.repeat = value.repeat === true;
  if ('pauseMs' in value) {
    if (!Number.isInteger(value.pauseMs) || value.pauseMs < 3000 || value.pauseMs > 10000) throw new Error('수집 간격은 3~10초입니다.');
    result.pauseMs = value.pauseMs;
  }
  return result;
}

export class Collector extends EventEmitter {
  constructor(profile, outputDir) {
    super();
    this.profile = profile;
    fs.mkdirSync(profile, { recursive: true });
    const stored = readJson(path.join(profile, 'settings.json'), {});
    try { this.config = validateSettings(stored); } catch { this.config = { ...defaults }; }
    this.outputDir = typeof stored.outputDir === 'string' && path.isAbsolute(stored.outputDir) ? stored.outputDir : outputDir;
    this.state = { phase: 'idle', count: 0, actions: 0, lastAction: '수집할 목록을 선택하고 시작해주세요.', logs: [], nextRunAt: null, lastResults: {} };
    for (const source of ['returns', 'goldbox']) {
      const saved = readJson(this.checkpoint(source));
      if (saved) this.state.lastResults[source] = this.summary(saved);
    }
    this.timer = setInterval(() => this.schedule(), 10000);
  }
  checkpoint(source = this.config.sourceKey) { return path.join(this.profile, 'checkpoints', `${source}.json`); }
  summary(data) { return { count: data.productCount || 0, updatedAt: data.updatedAt, complete: !!data.collectionComplete, resumable: !data.collectionComplete && !!data.products?.length, status: data.status }; }
  snapshot() { return { ...this.state, config: { ...this.config }, outputDir: this.outputDir, busy: !!this.running }; }
  publish() { this.emit('change', this.snapshot()); }
  log(message) {
    this.state.logs.push({ at: new Date().toISOString(), message });
    this.state.logs = this.state.logs.slice(-80);
    // Only application status is logged; no cookies, headers, credentials, or page console output.
    fs.appendFileSync(path.join(this.profile, 'collector.log'), `${new Date().toISOString()} ${message}\n`);
    this.publish();
  }
  settings(value) {
    if (this.running) throw new Error('진행 중인 수집을 중지한 뒤 설정을 변경해주세요.');
    this.config = validateSettings(value, this.config);
    if ('outputDir' in value) {
      if (typeof value.outputDir !== 'string' || !path.isAbsolute(value.outputDir)) throw new Error('올바른 저장 폴더가 필요합니다.');
      fs.mkdirSync(value.outputDir, { recursive: true });
      this.outputDir = value.outputDir;
    }
    writeJson(path.join(this.profile, 'settings.json'), { ...this.config, outputDir: this.outputDir });
    this.state.nextRunAt = null;
    this.state.phase = 'idle'; this.state.count = 0; this.state.actions = 0; this.state.startedAt = null; this.state.error = null;
    this.state.lastAction = '수집할 목록을 선택하고 시작해주세요.';
    this.publish();
    return this.snapshot();
  }
  start(resume = false) {
    if (this.running) throw new Error('이미 수집 중입니다.');
    const source = this.config.sourceKey;
    if (resume && !this.state.lastResults[source]?.resumable) throw new Error('이어받을 부분 결과가 없습니다.');
    this.stopRequested = false;
    this.state.phase = 'running'; this.state.count = 0; this.state.actions = 0;
    this.state.startedAt = new Date().toISOString();
    this.state.lastAction = resume ? '저장된 결과 이어받는 중' : '목록 브라우저 여는 중';
    this.state.error = null;
    this.state.nextRunAt = this.config.repeat ? Date.now() + this.config.intervalMinutes * 60000 : null;
    this.running = this.run(source, resume).finally(() => { this.running = null; this.publish(); });
    this.publish();
    return this.snapshot();
  }
  async run(source, resume) {
    const module = source === 'goldbox' ? goldbox : returns;
    const checkpointFile = this.checkpoint(source);
    const stopFile = path.join(path.dirname(checkpointFile), 'stop');
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.rmSync(stopFile, { force: true });
    const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_') + '-' + source;
    let job, failure;
    const blocker = powerSaveBlocker.start('prevent-app-suspension');
    this.log(`${source === 'goldbox' ? '골드박스' : '반품마켓'} ${resume ? '이어 ' : ''}수집을 시작했습니다.`);
    try {
      job = await module.initialize({
        context: { newPage: async () => {
          this.page = new ElectronPage({ sourceUrl: module.SOURCE_URL });
          return this.page;
        }},
        config: { ...this.config, sourceUrl: module.SOURCE_URL, bottomStableRounds: 5, maxActions: 12000, maxRunMinutes: 180, closeTabOnFinish: true },
        helpers, checkpointFile, runId, seedFile: resume ? checkpointFile : null
      });
      while (job.status === 'running') {
        if (this.stopRequested) fs.writeFileSync(stopFile, 'stop');
        const progress = await module.step(job, 1);
        this.state.count = progress.count;
        this.state.actions = progress.actions;
        this.state.lastAction = progress.lastAction;
        this.publish();
      }
    } catch (error) {
      failure = error;
      this.state.error = error.message;
      this.log(`수집 중단: ${error.message}`);
    } finally {
      try {
        if (job) {
          await module.close(job, !!failure || this.stopRequested);
          const data = readJson(checkpointFile);
          data.sourceKey = source;
          if (failure) { data.errors ||= []; data.errors.push(failure.message); }
          writeJson(checkpointFile, data);
          const folder = saveExport(this.outputDir, source, data);
          this.state.lastResults[source] = this.summary(data);
          this.state.count = data.productCount;
          this.state.phase = failure ? 'error' : data.collectionComplete ? 'complete' : 'partial';
          this.state.lastAction = `${data.productCount.toLocaleString()}개 ${data.collectionComplete ? '수집 완료' : '부분 결과 저장'}`;
          this.state.lastFolder = folder;
          this.log(`${this.state.lastAction} · JSON / CSV 저장 완료`);
        } else {
          this.state.phase = this.stopRequested ? 'partial' : 'error';
          this.state.lastAction = '목록을 열지 못했습니다. 접근 상태와 인터넷 연결을 확인해주세요.';
        }
      } catch (error) {
        this.state.phase = 'error'; this.state.error = error.message;
        this.log(`결과 저장 확인 필요: ${error.message}`);
      }
      if (this.page && !this.page.isClosed()) await this.page.close();
      this.page = null;
      if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      fs.rmSync(stopFile, { force: true });
      this.publish();
    }
  }
  stop() {
    this.state.nextRunAt = null;
    if (this.running) {
      this.stopRequested = true;
      this.state.phase = 'stopping';
      this.state.lastAction = '현재 동작이 끝나면 결과를 저장합니다.';
      this.publish();
    } else this.publish();
    return this.snapshot();
  }
  schedule() {
    if (!this.state.nextRunAt || Date.now() < this.state.nextRunAt) return;
    if (this.running) {
      this.state.nextRunAt += this.config.intervalMinutes * 60000;
      this.log('이전 수집이 진행 중이어서 이번 반복을 건너뛰었습니다.');
    } else this.start(false);
  }
  showBrowser() { this.page?.show(); }
  async shutdown() { clearInterval(this.timer); this.stop(); if (this.running) await this.running; }
}
