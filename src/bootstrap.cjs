const { app } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Initialize Chromium before loading the ESM graph; no top-level ready wait in its loader.
if (process.argv.some(arg => ['--smoke-test', '--probe-list', '--collect-test'].includes(arg))) {
  app.setPath('userData', path.join(app.getPath('temp'), `returnpick-electron-test-${process.pid}`));
}
app.whenReady().then(() => import(pathToFileURL(path.join(__dirname, 'main.mjs')).href)).catch(error => {
  console.error('ReturnPick startup failed:', error);
  app.exit(1);
});
