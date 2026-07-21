(function (global) {
  'use strict';

  const ENDPOINT = 'https://exam-sync-d8gommblnb5c9fdfa-1407765798.ap-shanghai.app.tcloudbase.com/quiz-sync';
  const STORE_HISTORY = 'sihai_quiz_history_v1';
  const STORE_FAVS = 'sihai_quiz_favs_v1';
  const STORE_OVERRIDES = 'sihai_quiz_overrides_v1';
  const STORE_SESSIONS = 'sihai_quiz_sessions_v1';
  const STORE_CONFIG = 'sihai_quiz_sync_config_v1';
  const STORE_META = 'sihai_quiz_sync_meta_v1';
  const STORE_QUEUE = 'sihai_quiz_sync_queue_v1';
  const SYNC_DEBOUNCE_MS = 1200;
  const SYNC_TIMEOUT_MS = 15000;
  const SYNC_RETRY_MS = 6000;
  const MAX_BATCH = 250;

  let applyingRemote = false;
  let syncTimer = 0;
  let syncing = false;
  let hooks = {};

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function makeDeviceId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return 'device-' + global.crypto.randomUUID();
    }
    return 'device-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function loadConfig() {
    const config = readJson(STORE_CONFIG, {});
    if (!config.deviceId) {
      config.deviceId = makeDeviceId();
      writeJson(STORE_CONFIG, config);
    }
    return config;
  }

  function saveConfig(config) {
    writeJson(STORE_CONFIG, config);
  }

  function loadMeta() {
    return Object.assign({cursor: 0, migrated: false, lastSyncAt: 0, lastOpAt: 0}, readJson(STORE_META, {}));
  }

  function saveMeta(meta) {
    writeJson(STORE_META, meta);
  }

  function loadQueue() {
    return readJson(STORE_QUEUE, {});
  }

  function saveQueue(queue) {
    writeJson(STORE_QUEUE, queue);
  }

  function nextModifiedAt(preferred) {
    const meta = loadMeta();
    const now = Date.now();
    const value = Math.max(now, Number(preferred) || 0, Number(meta.lastOpAt) + 1 || 0);
    meta.lastOpAt = value;
    saveMeta(meta);
    return value;
  }

  function updateStatus(mode, detail) {
    const config = loadConfig();
    const queueCount = Object.keys(loadQueue()).length;
    let text = detail || '';
    if (!text) {
      if (!config.syncCode) text = '未设置 · 数据只保存在本机';
      else if (!navigator.onLine) text = queueCount ? `离线 · ${queueCount} 项等待同步` : '离线 · 联网后自动同步';
      else if (mode === 'syncing') text = '正在同步…';
      else if (mode === 'error') text = '同步失败 · 点击重试';
      else if (queueCount) text = `${queueCount} 项等待同步`;
      else {
        const last = loadMeta().lastSyncAt;
        text = last ? `已同步 · ${new Date(last).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}` : '已启用 · 等待首次同步';
      }
    }

    const status = document.getElementById('syncStatusText');
    if (status) status.textContent = text;
    const bannerTitle = document.getElementById('syncBannerTitle');
    const bannerText = document.getElementById('syncBannerText');
    if (bannerTitle && bannerText) {
      if (!config.syncCode) {
        bannerTitle.textContent = '数据保存在当前设备';
        bannerText.textContent = '设置云同步后，可在电脑和手机之间自动接续。';
      } else if (mode === 'error') {
        bannerTitle.textContent = '本地数据安全';
        bannerText.textContent = '云端暂时未连接，本机记录不会丢失，联网后可重试。';
      } else if (!navigator.onLine || queueCount) {
        bannerTitle.textContent = '本地已保存';
        bannerText.textContent = '还有数据等待上传，离开前请确认显示“已同步”。';
      } else {
        bannerTitle.textContent = '云同步已开启';
        bannerText.textContent = '电脑和手机登录同一同步口令后，会自动接续最新状态。';
      }
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    if (!loadConfig().syncCode) {
      updateStatus('idle');
      return;
    }
    updateStatus(navigator.onLine ? 'pending' : 'offline');
    if (!navigator.onLine) return;
    syncTimer = setTimeout(() => syncNow(), SYNC_DEBOUNCE_MS);
  }

  function enqueue(operation, options) {
    if (applyingRemote || !operation || !operation.key) return;
    const queue = loadQueue();
    const current = queue[operation.key];
    const modifiedAt = Number(operation.modifiedAt) || nextModifiedAt();
    const next = Object.assign({}, operation, {
      modifiedAt,
      deviceId: loadConfig().deviceId,
    });
    if (!current || Number(current.modifiedAt) <= modifiedAt) {
      queue[next.key] = next;
      saveQueue(queue);
    }
    if (!options || options.schedule !== false) scheduleSync();
  }

  function historyMap(list) {
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (item && item.sessionId) map.set(String(item.sessionId), item);
    }
    return map;
  }

  function captureHistory(before, after) {
    if (applyingRemote) return;
    const oldMap = historyMap(before);
    const newMap = historyMap(after);
    const ids = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const id of ids) {
      const oldValue = oldMap.get(id);
      const newValue = newMap.get(id);
      if (sameValue(oldValue, newValue)) continue;
      enqueue({
        key: 'history:' + id,
        kind: 'history',
        itemId: id,
        value: newValue || null,
        deleted: !newValue,
        modifiedAt: nextModifiedAt(),
      });
    }
  }

  function favoriteSet(source, paperId) {
    return new Set(((source && source[paperId]) || []).map(value => String(value)));
  }

  function captureFavorites(before, after) {
    if (applyingRemote) return;
    const papers = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const paperId of papers) {
      const oldSet = favoriteSet(before, paperId);
      const newSet = favoriteSet(after, paperId);
      const items = new Set([...oldSet, ...newSet]);
      for (const itemId of items) {
        const wasOn = oldSet.has(itemId);
        const isOn = newSet.has(itemId);
        if (wasOn === isOn) continue;
        enqueue({
          key: `favorite:${paperId}:${itemId}`,
          kind: 'favorite',
          paperId,
          itemId,
          value: isOn,
          deleted: !isOn,
          modifiedAt: nextModifiedAt(),
        });
      }
    }
  }

  function captureObjectRecords(kind, before, after) {
    if (applyingRemote) return;
    const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const paperId of ids) {
      const oldValue = before ? before[paperId] : undefined;
      const newValue = after ? after[paperId] : undefined;
      if (sameValue(oldValue, newValue)) continue;
      const preferred = kind === 'session' && newValue ? newValue.savedAt : 0;
      enqueue({
        key: kind + ':' + paperId,
        kind,
        paperId,
        value: newValue || null,
        deleted: newValue == null,
        modifiedAt: nextModifiedAt(preferred),
      });
    }
  }

  function captureSessions(before, after) {
    captureObjectRecords('session', before, after);
  }

  function captureOverrides(before, after) {
    captureObjectRecords('override', before, after);
  }

  function migrateLocalData() {
    const meta = loadMeta();
    if (meta.migrated) return;
    const config = loadConfig();
    const history = readJson(STORE_HISTORY, []);
    const favorites = readJson(STORE_FAVS, {});
    const sessions = readJson(STORE_SESSIONS, {});
    const overrides = readJson(STORE_OVERRIDES, {});

    for (const item of history) {
      if (!item || !item.sessionId) continue;
      enqueue({
        key: 'history:' + item.sessionId,
        kind: 'history',
        itemId: String(item.sessionId),
        value: item,
        deleted: false,
        modifiedAt: Number(item.finishedAt || item.startedAt) || Date.now(),
        deviceId: config.deviceId,
      }, {schedule: false});
    }
    for (const paperId of Object.keys(favorites)) {
      for (const qNum of favorites[paperId] || []) {
        enqueue({
          key: `favorite:${paperId}:${qNum}`,
          kind: 'favorite',
          paperId,
          itemId: String(qNum),
          value: true,
          deleted: false,
          modifiedAt: Date.now(),
          deviceId: config.deviceId,
        }, {schedule: false});
      }
    }
    for (const paperId of Object.keys(sessions)) {
      const session = sessions[paperId];
      enqueue({
        key: 'session:' + paperId,
        kind: 'session',
        paperId,
        value: session,
        deleted: false,
        modifiedAt: Number(session && session.savedAt) || Date.now(),
        deviceId: config.deviceId,
      }, {schedule: false});
    }
    for (const paperId of Object.keys(overrides)) {
      enqueue({
        key: 'override:' + paperId,
        kind: 'override',
        paperId,
        value: overrides[paperId],
        deleted: false,
        modifiedAt: Date.now(),
        deviceId: config.deviceId,
      }, {schedule: false});
    }
    meta.migrated = true;
    saveMeta(meta);
    updateStatus('pending');
  }

  function applyRecords(records) {
    if (!Array.isArray(records) || !records.length) return false;
    const queue = loadQueue();
    const history = historyMap(readJson(STORE_HISTORY, []));
    const favorites = readJson(STORE_FAVS, {});
    const sessions = readJson(STORE_SESSIONS, {});
    const overrides = readJson(STORE_OVERRIDES, {});
    let changed = false;

    applyingRemote = true;
    try {
      for (const record of records) {
        if (!record || !record.key) continue;
        const pending = queue[record.key];
        if (pending && Number(pending.modifiedAt) > Number(record.modifiedAt)) continue;
        if (record.kind === 'history') {
          if (record.deleted) history.delete(String(record.itemId));
          else if (record.value && record.itemId) history.set(String(record.itemId), record.value);
          changed = true;
        } else if (record.kind === 'favorite' && record.paperId) {
          const list = new Set((favorites[record.paperId] || []).map(value => String(value)));
          if (record.deleted) list.delete(String(record.itemId));
          else list.add(String(record.itemId));
          favorites[record.paperId] = Array.from(list).map(value => /^\d+$/.test(value) ? Number(value) : value);
          if (!favorites[record.paperId].length) delete favorites[record.paperId];
          changed = true;
        } else if (record.kind === 'session' && record.paperId) {
          if (record.deleted) delete sessions[record.paperId];
          else sessions[record.paperId] = record.value;
          changed = true;
        } else if (record.kind === 'override' && record.paperId) {
          if (record.deleted) delete overrides[record.paperId];
          else overrides[record.paperId] = record.value;
          changed = true;
        }
      }
      if (changed) {
        writeJson(STORE_HISTORY, Array.from(history.values()).sort((a, b) => Number(a.finishedAt) - Number(b.finishedAt)));
        writeJson(STORE_FAVS, favorites);
        writeJson(STORE_SESSIONS, sessions);
        writeJson(STORE_OVERRIDES, overrides);
      }
    } finally {
      applyingRemote = false;
    }
    if (changed && typeof hooks.onRemoteApplied === 'function') hooks.onRemoteApplied();
    return changed;
  }

  async function syncNow(options) {
    const config = loadConfig();
    if (!config.syncCode || syncing || !navigator.onLine) {
      updateStatus(navigator.onLine ? 'idle' : 'offline');
      return false;
    }
    clearTimeout(syncTimer);
    syncing = true;
    updateStatus('syncing');
    const meta = loadMeta();
    const queue = loadQueue();
    const operations = Object.values(queue)
      .sort((a, b) => Number(a.modifiedAt) - Number(b.modifiedAt))
      .slice(0, MAX_BATCH);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abortTimer = controller ? setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS) : 0;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + config.syncCode,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: config.deviceId,
          since: Number(meta.cursor) || 0,
          operations,
        }),
        cache: 'no-store',
        keepalive: !!(options && options.keepalive),
        signal: controller ? controller.signal : undefined,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || '云端连接失败');

      const latestQueue = loadQueue();
      const accepted = new Set(result.acceptedKeys || []);
      for (const operation of operations) {
        const current = latestQueue[operation.key];
        if (accepted.has(operation.key) && current && Number(current.modifiedAt) <= Number(operation.modifiedAt)) {
          delete latestQueue[operation.key];
        }
      }
      saveQueue(latestQueue);
      applyRecords(result.records || []);
      meta.cursor = Number(result.cursor) || meta.cursor;
      meta.lastSyncAt = Date.now();
      meta.lastError = '';
      saveMeta(meta);
      updateStatus('ok');
      if (options && options.announce && typeof global.toast === 'function') global.toast('云同步已完成');
      if (Object.keys(latestQueue).length) scheduleSync();
      return true;
    } catch (error) {
      const timedOut = error && error.name === 'AbortError';
      meta.lastError = timedOut ? '云端响应超时' : (error && error.message ? error.message : '同步失败');
      saveMeta(meta);
      updateStatus('error', meta.lastError === '同步口令不正确' ? '同步口令不正确 · 点击重新设置' : `${meta.lastError} · 本地记录已保存`);
      if (navigator.onLine && config.syncCode) {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => syncNow(), SYNC_RETRY_MS);
      }
      return false;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      syncing = false;
    }
  }

  function requestSyncCode(hasExisting) {
    return new Promise((resolve) => {
      const oldDialog = document.getElementById('syncSetupDialog');
      if (oldDialog) oldDialog.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'syncSetupDialog';
      backdrop.setAttribute('role', 'presentation');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;';
      backdrop.innerHTML = `
        <div role="dialog" aria-modal="true" aria-labelledby="syncDialogTitle" style="width:min(420px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(15,23,42,.25);color:#172033;">
          <div id="syncDialogTitle" style="font-size:19px;font-weight:750;margin-bottom:8px;">设置电脑与手机同步</div>
          <div style="font-size:14px;line-height:1.65;color:#667085;margin-bottom:16px;">在每台电脑和手机上输入同一个同步口令，做题状态就会自动接续。${hasExisting ? '当前设备已经设置；留空可直接立即同步。' : ''}</div>
          <label for="syncCodeInput" style="display:block;font-size:14px;font-weight:650;margin-bottom:7px;">同步口令</label>
          <input id="syncCodeInput" type="password" autocomplete="off" spellcheck="false" placeholder="${hasExisting ? '留空表示继续使用当前口令' : '请输入同步口令'}" style="box-sizing:border-box;width:100%;height:46px;border:1.5px solid #d0d5dd;border-radius:11px;padding:0 13px;font-size:16px;outline:none;">
          <div id="syncCodeError" role="alert" style="display:none;color:#b42318;font-size:13px;margin-top:8px;">请先输入同步口令</div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
            <button type="button" data-sync-cancel style="border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:10px;padding:10px 17px;font-size:14px;font-weight:650;">取消</button>
            <button type="button" data-sync-save style="border:1px solid #174c70;background:#174c70;color:#fff;border-radius:10px;padding:10px 17px;font-size:14px;font-weight:650;">保存并同步</button>
          </div>
        </div>`;

      const input = backdrop.querySelector('#syncCodeInput');
      const error = backdrop.querySelector('#syncCodeError');
      const finish = (value) => {
        backdrop.remove();
        resolve(value);
      };
      const submit = () => {
        const value = String(input.value || '').trim().toUpperCase();
        if (!value && !hasExisting) {
          error.style.display = 'block';
          input.focus();
          return;
        }
        finish(value);
      };

      backdrop.querySelector('[data-sync-cancel]').addEventListener('click', () => finish(null));
      backdrop.querySelector('[data-sync-save]').addEventListener('click', submit);
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(null);
      });
      input.addEventListener('input', () => { error.style.display = 'none'; });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
        if (event.key === 'Escape') finish(null);
      });
      document.body.appendChild(backdrop);
      setTimeout(() => input.focus(), 0);
    });
  }

  async function setup() {
    const config = loadConfig();
    const value = await requestSyncCode(!!config.syncCode);
    if (value === null) return;
    const normalized = String(value).trim().toUpperCase();
    if (normalized) {
      config.syncCode = normalized;
      saveConfig(config);
      const meta = loadMeta();
      meta.cursor = 0;
      meta.migrated = false;
      meta.lastError = '';
      saveMeta(meta);
      migrateLocalData();
    }
    await syncNow({announce: true});
  }

  async function init(options) {
    hooks = options || {};
    const config = loadConfig();
    updateStatus('idle');
    global.addEventListener('online', () => syncNow());
    global.addEventListener('offline', () => updateStatus('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow();
      else syncNow({keepalive: true});
    });
    global.addEventListener('pagehide', () => syncNow({keepalive: true}));
    if (config.syncCode) {
      migrateLocalData();
      await syncNow();
    }
  }

  global.QuizSync = {
    init,
    setup,
    syncNow,
    updateStatus,
    captureHistory,
    captureFavorites,
    captureSessions,
    captureOverrides,
    isApplyingRemote: () => applyingRemote,
  };
})(window);
