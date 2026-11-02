// Drives the built app with Playwright and saves screenshots of each screen.
// Usage: xvfb-run -a node scripts/screenshots.cjs <outDir> [--seed]
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const out = path.resolve(process.argv[2] || 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'om-shot-'));
  const app = await electron.launch({
    // OM_EXE = packaged binary (e.g. extracted AppImage) ; otherwise the dev app.
    executablePath: process.env.OM_EXE || require('electron'),
    args: process.env.OM_EXE ? ['--no-sandbox'] : ['--no-sandbox', path.resolve(__dirname, '..')],
    env: { ...process.env, OM_USER_DATA: userData, NODE_OPTIONS: '' },
  });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()));
  win.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await win.setViewportSize({ width: 1360, height: 860 }).catch(() => {});
  await win.waitForTimeout(1500);
  const shot = async (name) => {
    await win.waitForTimeout(900);
    await win.screenshot({ path: path.join(out, name + '.png') });
    console.log('shot', name);
  };
  // onboarding
  await shot('00-onboarding');
  await win.click('text=Configurer mon programme');
  await shot('01-onboarding-temps');
  await win.click('text=Suivant');
  await win.click('text=Suivant');
  await win.click('text=nourriture');
  await win.click('text=voyage');
  await win.click('text=Commencer la formation');
  await win.waitForTimeout(1200);
  await shot('02-qg');
  const nav = async (label, name) => {
    await win.click(`.nav-item:has-text("${label}")`);
    await shot(name);
  };
  // learn 3 words
  await win.click('.nav-item:has-text("Nouveaux mots")');
  await win.waitForTimeout(1500);
  await shot('03-nouveau-mot');
  // go through the presentation + quiz with the keyboard
  for (let k = 0; k < 8; k++) { await win.keyboard.press('Enter'); await win.waitForTimeout(250); }
  await shot('03b-quiz');
  for (let k = 0; k < 250; k++) {
    if (await win.$('text=mot(s) ajoutés')) break;
    await win.keyboard.press('1'); await win.waitForTimeout(150);
    await win.keyboard.press('Enter'); await win.waitForTimeout(200);
  }
  await shot('03c-mots-ajoutes');
  await nav('Révisions', '04-revisions');
  await win.keyboard.press('Space');
  await shot('04b-revision-reponse');
  await nav('Écriture', '05-ecriture');
  await win.click('text=Commencer');
  await win.waitForTimeout(2500);
  await shot('05b-ecriture-observer');
  await win.keyboard.press('Enter');
  await shot('05c-ecriture-copier');
  await win.keyboard.press('Enter');
  await shot('05d-ecriture-memoire');
  await win.keyboard.press('Enter');
  await shot('05e-ecriture-comparer');
  await nav('Grammaire', '06-grammaire');
  await nav('Tons & oral', '07-tons');
  await nav('Missions vidéo', '08-missions');
  await nav('Lecture', '09-lecture');
  await nav('Jeu de rôle', '10-jeu-de-role');
  await nav('Examens', '11-examens');
  await nav('Dictionnaire', '12-dictionnaire');
  await win.fill('input', '朋友');
  await shot('12b-dictionnaire-recherche');
  await nav('Progression', '13-progression');
  await nav('Réglages', '14-reglages');
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
