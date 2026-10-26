import { app } from 'electron';

void app.whenReady().then(() => {
  app.quit();
});
