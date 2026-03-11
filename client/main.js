const { app, BrowserWindow } = require('electron');
const path = require('path');

const isDev = process.argv.includes('--dev');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Hermes — Personal Knowledge Messenger',
    backgroundColor: '#0f0f0f',
    show: false,
  });

  if (isDev) {
    win.loadURL(process.env.HERMES_SERVER_URL || 'http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadURL(process.env.HERMES_SERVER_URL || 'http://localhost:3000');
  }

  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
