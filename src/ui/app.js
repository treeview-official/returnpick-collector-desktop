const $ = id => document.getElementById(id);
let state, toastTimer, queue = Promise.resolve();
const labels = { idle: '준비됨', running: '수집 중', stopping: '저장 준비 중', complete: '수집 완료', partial: '부분 저장', error: '확인 필요' };
const time = value => new Date(value).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
function render(next) {
  state = next;
  const { config, busy } = state;
  const saved = state.lastResults[config.sourceKey];
  document.querySelectorAll('[data-source]').forEach(button => {
    const selected = button.dataset.source === config.sourceKey;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = busy;
  });
  $('repeat').checked = config.repeat; $('interval').value = config.intervalMinutes; $('pause').value = config.pauseMs;
  for (const id of ['repeat', 'interval', 'pause', 'choose']) $(id).disabled = busy;
  $('status').textContent = labels[state.phase] || state.phase; $('status').className = 'status ' + state.phase;
  $('action').textContent = state.lastAction;
  $('count').textContent = (state.phase === 'idle' ? saved?.count || 0 : state.count).toLocaleString();
  $('start').disabled = busy; $('stop').disabled = !busy && !state.nextRunAt;
  $('resume').disabled = busy || !saved?.resumable;
  $('browser').disabled = !busy;
  $('activity').classList.toggle('active', busy);
  $('saved').textContent = saved ? `${time(saved.updatedAt)} · ${saved.complete ? '전체 수집' : '부분 결과'} ${saved.count.toLocaleString()}개` : '이 목록의 기록이 없습니다';
  $('folder').textContent = state.outputDir; $('folder').title = state.outputDir;
  $('error').hidden = !state.error; $('error').textContent = state.error || '';
  const log = $('logs');
  if (state.logs.length) {
    log.replaceChildren(...state.logs.map(entry => { const p = document.createElement('p'), t = document.createElement('time'); t.textContent = time(entry.at); p.append(t, document.createTextNode(entry.message)); return p; }));
    log.scrollTop = log.scrollHeight;
  }
  updateClocks();
}
function updateClocks() {
  if (!state) return;
  const seconds = state.startedAt ? Math.floor(((state.busy ? Date.now() : Date.parse(state.logs.at(-1)?.at || state.startedAt)) - Date.parse(state.startedAt)) / 1000) : 0;
  $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`;
  $('next').textContent = state.nextRunAt ? time(state.nextRunAt) : '예약 없음';
}
function action(fn) {
  queue = queue.then(fn).catch(error => {
    $('toast').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000);
  });
}
document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => action(() => window.collector.settings({ sourceKey: button.dataset.source }))));
for (const id of ['repeat', 'interval', 'pause']) $(id).addEventListener('change', () => action(() => window.collector.settings({ repeat: $('repeat').checked, intervalMinutes: Number($('interval').value), pauseMs: Number($('pause').value) })));
$('start').addEventListener('click', () => action(() => window.collector.start(false)));
$('resume').addEventListener('click', () => action(() => window.collector.start(true)));
$('stop').addEventListener('click', () => action(() => window.collector.stop()));
$('choose').addEventListener('click', () => action(() => window.collector.selectFolder()));
$('open').addEventListener('click', () => action(() => window.collector.openFolder()));
$('browser').addEventListener('click', () => action(() => window.collector.showBrowser()));
window.collector.onChange(render);
action(async () => render(await window.collector.state()));
setInterval(updateClocks, 1000);
