/* global supabase, APP_CONFIG */
const client = window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabasePublishableKey);
const $ = selector => document.querySelector(selector);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('kb-theme', theme);
  const el = $('#theme-toggle');
  if (el) el.textContent = theme === 'dark' ? '浅色' : '深色';
  if (el) el.setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}模式`);
}

function initTheme() {
  setTheme(localStorage.getItem('kb-theme') || 'dark');
  $('#theme-toggle')?.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function humanError(error) {
  const msg = String(error?.message || error || '');
  if (/invalid login credentials/i.test(msg)) return '邮箱或密码不对，请检查后再试。';
  if (/email not confirmed/i.test(msg)) return '邮箱还没有确认。若你已关闭邮箱确认，请重新注册或登录。';
  if (/row-level security|violates row-level/i.test(msg)) return '权限校验没有通过，请重新登录后再试。';
  if (/fetch|network/i.test(msg)) return '网络连接失败，请刷新页面后再试。';
  return msg || '操作失败，请稍后再试。';
}

function setMessage(text, type = '') {
  const el = $('#message');
  if (el) {
    el.textContent = text;
    el.className = `message ${type}`;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getUser() {
  const { data: { user } } = await client.auth.getUser();
  return user;
}

async function requireUser() {
  const user = await getUser();
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    location.href = `/?next=${encodeURIComponent(next)}`;
    return null;
  }
  return user;
}

function taskClass(status) {
  return `status status-${status}`;
}

async function renderTasks(user) {
  const target = $('#task-list');
  if (!target) return;
  const { data, error } = await client
    .from('keyword_tasks')
    .select('id,asin,status,report_link,failure_reason,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    target.innerHTML = `<div class="empty">读取任务失败：${escapeHtml(humanError(error))}</div>`;
    return;
  }
  if (!data?.length) {
    target.innerHTML = '<div class="empty">还没有任务。提交第一份广告报表后，进度会显示在这里。</div>';
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>提交时间</th><th>ASIN</th><th>状态</th><th>报告／失败原因</th></tr></thead><tbody>${data.map(t => `<tr><td>${new Date(t.created_at).toLocaleString()}</td><td>${escapeHtml(t.asin)}</td><td><span class="${taskClass(t.status)}">${escapeHtml(t.status)}</span></td><td>${t.report_link ? `<a class="button secondary" href="/report/?task=${encodeURIComponent(t.id)}">查看报告</a>` : escapeHtml(t.failure_reason || '等待工人领取')}</td></tr>`).join('')}</tbody></table></div>`;
}

async function initLogin() {
  const form = $('#auth-form');
  if (!form) return;
  const user = await getUser();
  if (user) {
    location.href = new URLSearchParams(location.search).get('next') || '/tool/';
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    setMessage('正在登录...');
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(humanError(error), 'error');
      return;
    }
    location.href = new URLSearchParams(location.search).get('next') || '/tool/';
  });
  $('#sign-up').addEventListener('click', async () => {
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || !password) {
      setMessage('先填写邮箱和密码。', 'error');
      return;
    }
    setMessage('正在注册...');
    const { error } = await client.auth.signUp({ email, password });
    setMessage(error ? humanError(error) : '注册成功，现在可以登录。', error ? 'error' : 'ok');
  });
}

async function initTool() {
  if (!$('#task-form')) return;
  const user = await requireUser();
  if (!user) return;
  $('#user-email').textContent = user.email || '已登录';
  $('#sign-out').addEventListener('click', async () => {
    await client.auth.signOut();
    location.href = '/';
  });
  const refresh = () => renderTasks(user);
  $('#refresh-tasks')?.addEventListener('click', refresh);
  await refresh();
  setInterval(refresh, 30000);
  $('#task-form').addEventListener('submit', async event => {
    event.preventDefault();
    const asin = $('#asin').value.trim().toUpperCase();
    const file = $('#report-file').files[0];
    if (!/^B0[A-Z0-9]{8}$/.test(asin)) {
      setMessage('ASIN 必须是 10 位，并且以 B0 开头。', 'error');
      return;
    }
    if (!file || !(/\.(xlsx|csv)$/i.test(file.name))) {
      setMessage('请选择 .xlsx 或 .csv 广告报表。', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setMessage('报表不能超过 10MB。请压缩或拆分后再上传。', 'error');
      return;
    }
    const id = crypto.randomUUID();
    const ext = file.name.toLowerCase().endsWith('.csv') ? '.csv' : '.xlsx';
    const reportFilePath = `${user.id}/${id}${ext}`;
    $('#submit-task').disabled = true;
    setMessage('正在上传报表...');
    const { error: uploadError } = await client.storage.from('task-inbox').upload(reportFilePath, file, { upsert: false, contentType: file.type || undefined });
    if (uploadError) {
      $('#submit-task').disabled = false;
      setMessage(`上传失败：${humanError(uploadError)}`, 'error');
      return;
    }
    setMessage('正在创建任务...');
    const { error: insertError } = await client.from('keyword_tasks').insert({ id, user_id: user.id, asin, report_file_path: reportFilePath, status: '待处理' });
    $('#submit-task').disabled = false;
    if (insertError) {
      setMessage(`任务创建失败：${humanError(insertError)}。已上传文件不会被工人处理。`, 'error');
      return;
    }
    event.target.reset();
    setMessage('提交成功，工人将在约 30 秒内领取。', 'ok');
    refresh();
  });
}

function updateSummary(doc) {
  const rows = [...doc.querySelectorAll('tbody tr')];
  const rowText = row => row.textContent || '';
  const kindOf = row => {
    const text = rowText(row);
    if (/止损|暂停|降价|无订单/.test(text)) return 'stop';
    if (/重点进攻|进攻|放大/.test(text)) return 'attack';
    if (/防守|守住/.test(text)) return 'defense';
    return 'observe';
  };
  const counts = { stop: 0, attack: 0, defense: 0, observe: 0 };
  rows.forEach(row => {
    const kind = kindOf(row);
    counts[kind] += 1;
    row.classList.add(`action-${kind}`);
  });
  $('#sum-defense').textContent = counts.defense;
  $('#sum-attack').textContent = counts.attack;
  $('#sum-stop').textContent = counts.stop;
  $('#sum-observe').textContent = counts.observe;
}

async function initReport() {
  const host = $('#report-content');
  if (!host) return;
  const user = await requireUser();
  if (!user) return;
  const taskId = new URLSearchParams(location.search).get('task');
  if (!taskId) {
    host.innerHTML = '<div class="empty">从工具页的“查看报告”进入，或在地址后添加 ?task=任务号。</div>';
    return;
  }
  try {
    host.innerHTML = '<div class="empty">正在加载报告...</div>';
    const { data: task, error } = await client
      .from('keyword_tasks')
      .select('id,status,report_link,failure_reason')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (!task) throw new Error('没有找到这条任务，或它不属于当前账号。');
    if (task.status !== '已完成' || !task.report_link) throw new Error(task.failure_reason || `任务当前状态：${task.status}`);
    const response = await fetch(task.report_link);
    if (!response.ok) throw new Error(`报告读取失败，HTTP ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    updateSummary(doc);
    host.innerHTML = doc.body.innerHTML;
  } catch (error) {
    host.innerHTML = `<div class="empty">${escapeHtml(humanError(error))}。请确认任务已完成，且 OSS CORS 已允许本站域名。</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLogin();
  initTool();
  initReport();
});
