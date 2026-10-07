/**
 * TRING cloud sync backend (Google Apps Script web app).
 * Stores the app state as one JSON file in your Google Drive.
 *
 * Setup:
 * 1. script.google.com > New project > paste this file.
 * 2. Run setup() once, approve permissions, copy the token from the execution log.
 * 3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 * 4. Paste the /exec URL and the token into TRING > Settings > Cloud sync.
 */

const FILE_NAME = 'tring-data.json';

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  getFile_();
  Logger.log('TRING sync token: ' + token);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return json_({ ok: false, error: 'Unauthorized: check the sync token.' });

    if (body.action === 'get') return json_({ ok: true, data: read_() });

    if (body.action === 'set') {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const current = read_();
        // Ignore stale writes so an old device can't overwrite newer data
        if (current && (current.updatedAt || 0) > (body.data.updatedAt || 0)) {
          return json_({ ok: true, ignored: true });
        }
        getFile_().setContent(JSON.stringify(body.data));
      } finally {
        lock.releaseLock();
      }
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'TRING sync' });
}

function getFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FILE_ID');
  if (id) {
    try { return DriveApp.getFileById(id); } catch (e) { /* recreated below */ }
  }
  const file = DriveApp.createFile(FILE_NAME, '{}', MimeType.PLAIN_TEXT);
  props.setProperty('FILE_ID', file.getId());
  return file;
}

function read_() {
  const text = getFile_().getBlob().getDataAsString();
  const data = text ? JSON.parse(text) : null;
  return data && data.assets ? data : null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
