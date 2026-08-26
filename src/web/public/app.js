'use strict';

const $ = (sel) => document.querySelector(sel);

let searchTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'rgba(255,107,107,0.6)' : '';
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setStatusDot(elId, connected) {
  const el = $(elId);
  const cls = connected ? 'dot-ok' : 'dot-bad';
  const label = connected ? 'Đã kết nối' : 'Mất kết nối';
  el.innerHTML = `<span class="dot ${cls}"></span>${label}`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadStatus() {
  try {
    const s = await api('/api/status');
    setStatusDot('#zaloStatus', s.zaloConnected);
    setStatusDot('#tgStatus', s.telegramConnected);
    $('#zaloName').textContent = s.zaloName ? `Tài khoản: ${s.zaloName}` : '';
    $('#tgGroup').textContent = s.telegramGroupId ? `Group: ${s.telegramGroupId}` : '';
    $('#topicCount').textContent = s.topicCount ?? '—';
    $('#uptime').textContent = formatUptime(s.uptimeSec);
  } catch (err) {
    setStatusDot('#zaloStatus', false);
    setStatusDot('#tgStatus', false);
    toast('Không lấy được trạng thái: ' + err.message, true);
  }
}

async function loadTopics() {
  const q = $('#search').value.trim();
  const body = $('#topicsBody');
  try {
    const data = await api('/api/topics?q=' + encodeURIComponent(q));
    if (!data.topics.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty">${q ? 'Không có topic nào khớp.' : 'Chưa có topic nào được map.'}</td></tr>`;
      return;
    }
    body.innerHTML = data.topics.map((t) => {
      const typeBadge = t.type === 1
        ? '<span class="badge">👥 Nhóm</span>'
        : '<span class="badge">👤 Cá nhân</span>';
      return `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${typeBadge}</td>
        <td><code>${escapeHtml(t.zaloId)}</code></td>
        <td><code>${t.topicId}</code></td>
        <td class="col-actions">
          <button class="btn btn-danger" data-del="${t.topicId}" data-name="${escapeHtml(t.name)}">Xóa</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty">Lỗi: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteTopic(topicId, name) {
  if (!confirm(`Xóa mapping cho topic "${name}" (ID ${topicId})?\nTin nhắn cũ sẽ không còn được đồng bộ.`)) return;
  try {
    await api('/api/topics/' + topicId, { method: 'DELETE' });
    toast(`Đã xóa mapping "${name}".`);
    await Promise.all([loadTopics(), loadStatus()]);
  } catch (err) {
    toast('Xóa thất bại: ' + err.message, true);
  }
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadTopics()]);
}

// ── Events ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  refreshAll();

  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadTopics, 250);
  });

  $('#refreshBtn').addEventListener('click', refreshAll);

  $('#reloadBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/reload', { method: 'POST' });
      toast(`Đã đọc lại từ đĩa — ${r.topicCount} topic.`);
      await refreshAll();
    } catch (err) {
      toast('Đọc lại thất bại: ' + err.message, true);
    }
  });

  $('#topicsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]');
    if (btn) deleteTopic(Number(btn.dataset.del), btn.dataset.name);
  });

  // Auto-refresh status every 10s.
  setInterval(loadStatus, 10000);
});
