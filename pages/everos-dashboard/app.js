// ─── EverOS · 进化中枢 v2 ────────────────────────────────────────────
// 双端统一前端（AstrBot 插件内嵌 + 独立服务器）
// 自动检测运行环境

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const log = (msg, data) => data
  ? console.log(`[EverOS] ${msg}`, data)
  : console.log(`[EverOS] ${msg}`);

// ═══ 桥接层 ──────────────────────────────────────────────────────

const isPlugin = typeof window.AstrBotPluginPage !== 'undefined';

// 独立模式下 API 前缀（由 standalone_server.py 提供）
const API_PREFIX = '/api/everos';

const API = {
  async get(endpoint) {
    if (isPlugin) {
      return await window.AstrBotPluginPage.apiGet(endpoint);
    }
    const r = await fetch(`${API_PREFIX}/${endpoint}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  },
  async post(endpoint, body) {
    if (isPlugin) {
      return await window.AstrBotPluginPage.apiPost(endpoint, body);
    }
    const r = await fetch(`${API_PREFIX}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  },
};

// ═══ 工具函数 ──────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function escape(text) {
  if (!text) return '';
  const el = document.createElement('div');
  el.textContent = String(text).slice(0, 500);
  return el.innerHTML;
}

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ═══ 主题切换 ──────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☾' : '☀';
  try { localStorage.setItem('everos-theme', theme); } catch {}
}

const saved = (() => { try { return localStorage.getItem('everos-theme'); } catch { return null; } })();
if (saved === 'dark' || (!saved && window.matchMedia?.('(prefers-color-scheme: dark)').matches)) {
  applyTheme('dark');
} else {
  applyTheme('light');
}

$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ═══ 总览 ──────────────────────────────────────────────────────

async function loadOverview() {
  try {
    const data = await API.get('status');
    const ok = data.healthy;

    // 状态点
    const dot = $('status-dot');
    dot.className = 'status-dot ' + (ok ? 'online pulse' : 'offline');
    $('status-text').textContent = ok ? '在线' : '离线';
    $('status-latency').textContent = data.latency ? `${data.latency}ms` : '';

    // 健康卡片
    const card = $('health-card');
    card.className = 'health-card ' + (ok ? 'online' : 'offline');
    const icon = $('health-icon');
    icon.className = 'health-card__icon' + (ok ? '' : ' error');

    $('health-title').textContent = ok
      ? '系统运行正常'
      : (data.error || '无法连接 EverOS');
    $('health-addr').innerHTML = `<code>${escape(data.base_url || '—')}</code> · <span>${data.latency ? `${data.latency}ms` : '—'}</span>`;
    $('health-sub').textContent = ok
      ? 'EverOS 自进化记忆系统'
      : '连接失败，请检查服务状态';
    $('health-app').textContent = data.app_id || '—';
    $('health-project').textContent = data.project_id || '—';

    // 组件状态
    const components = ['llm', 'sqlite', 'lancedb', 'cascade', 'ome'];
    components.forEach(c => {
      const el = $(`comp-${c}`);
      if (el) el.className = 'component__dot ' + (ok ? 'online' : 'offline');
    });

    // 记忆体征 + 比例条
    const stats = data.stats || {};
    const keys = [
      { key: 'episode', id: 'v-episode', bar: 'bar-episode', color: 'var(--blue)' },
      { key: 'atomic_fact', id: 'v-fact', bar: 'bar-fact', color: 'var(--purple)' },
      { key: 'agent_case', id: 'v-case', bar: 'bar-case', color: 'var(--amber)' },
      { key: 'agent_skill', id: 'v-skill', bar: 'bar-skill', color: 'var(--green)' },
    ];
    let total = 0;
    for (const k of keys) {
      const v = stats[k.key];
      const val = (v !== undefined && v >= 0) ? v : 0;
      total += val;
      animateNum($(k.id), val);
    }
    animateNum($('v-total'), total);

    // 比例条
    for (const k of keys) {
      const v = stats[k.key];
      const val = (v !== undefined && v >= 0) ? v : 0;
      const bar = $(k.bar);
      if (bar && total > 0) {
        bar.style.width = (val / total * 100) + '%';
        bar.style.setProperty('--color', k.color);
      } else if (bar) {
        bar.style.width = '0%';
      }
    }

    // 更新顶栏总记忆数
    $('header-total').textContent = total;
    $('overview-meta').textContent = ok ? `延迟 ${data.latency || '—'}ms` : '离线';
    $('uptime-display').textContent = ok ? `总计 ${total} 条记忆` : '等待连接...';

    // 获取独立服务器信息（端口等）
    if (!isPlugin) {
      try {
        const info = await API.get('server-info');
        if (info && info.port) {
          document.querySelectorAll('.standalone-port').forEach(el => {
            el.textContent = info.port;
          });
        }
      } catch {}
    }

    // 系统信息页更新
    $('sys-health').textContent = ok ? '✓ 正常' : '✗ 离线';
    $('sys-endpoint').textContent = data.base_url || '—';
    $('sys-app').textContent = `${data.app_id || '—'} / ${data.project_id || '—'}`;
    $('sys-latency').textContent = data.latency ? `${data.latency}ms` : '—';
    $('sys-version').textContent = data.app_id ? 'v1.0' : '—';
    $('sys-total-memories').textContent = total;
    $('sys-mode').textContent = isPlugin ? '插件内嵌' : '独立服务器';

    if (ok) loadActivity();
  } catch (e) {
    // 离线状态
    $('status-dot').className = 'status-dot offline';
    $('status-text').textContent = '离线';
    $('status-latency').textContent = '';
    $('health-title').textContent = '无法连接';
    $('health-sub').textContent = e.message;
    ['llm', 'sqlite', 'lancedb', 'cascade', 'ome'].forEach(c => {
      const el = $(`comp-${c}`);
      if (el) el.className = 'component__dot offline';
    });
    $('sys-health').textContent = '✗ 离线';
  }
}

function animateNum(el, val) {
  if (!el) return;
  const old = parseInt(el.textContent);
  el.textContent = val;
  if (!isNaN(old) && old !== val) {
    el.classList.remove('updating');
    void el.offsetWidth;
    el.classList.add('updating');
  }
}

async function loadActivity() {
  try {
    const data = await API.get('memories');
    const items = data.data?.data?.items || data.data?.items || [];
    const el = $('activity');
    if (!items.length) {
      el.innerHTML = '<p class="empty-state">还没有记忆沉淀</p>';
      return;
    }
    const show = items.slice(-8).reverse();
    el.innerHTML = show.map((m, i) => {
      const type = m.memory_type || m.type || 'memory';
      const content = (m.content || m.text || '').slice(0, 120);
      return `
        <div class="activity-item" style="animation-delay:${i * 60}ms">
          <div class="activity-item__dot"></div>
          <div class="activity-item__head">
            <span class="activity-item__tag ${escape(type)}">${escape(type)}</span>
            <span class="activity-item__time">${fmtTime(m.timestamp || m.created_at)}</span>
          </div>
          <div class="activity-item__text">${escape(content)}</div>
        </div>`;
    }).join('');
  } catch {
    $('activity').innerHTML = '<p class="empty-state">加载失败</p>';
  }
}

// ═══ 快速操作 ──────────────────────────────────────────────────

function setupQuickActions() {
  $('qa-write').addEventListener('click', () => {
    // 切换到记忆仓库 tab 并打开写入面板
    const memTab = document.querySelector('[data-tab="memories"]');
    if (memTab) memTab.click();
    setTimeout(() => $('write-panel')?.classList.remove('hidden'), 300);
  });

  $('qa-search').addEventListener('click', () => {
    // 切换到检索 tab 并聚焦搜索框
    const searchTab = document.querySelector('[data-tab="search"]');
    if (searchTab) searchTab.click();
    setTimeout(() => $('search-input')?.focus(), 300);
  });

  $('qa-flush').addEventListener('click', async () => {
    toast('正在触发记忆提炼...');
    try {
      // 调用 flush 端点
      const data = await API.post('flush', {
        session_id: 'webui',
        app_id: 'astrbot',
        project_id: 'default',
      });
      if (data.ok || data.status === 'ok') {
        toast('✓ 记忆提炼已触发', 'success');
      } else {
        toast('触发完成', 'success');
      }
      // 刷新总览
      setTimeout(() => loadOverview(), 1000);
    } catch (e) {
      toast(`✗ ${e.message}`, 'error');
    }
  });
}

// ═══ 记忆仓库 ──────────────────────────────────────────────────

let currentFilter = 'all';
let memStats = { episode: 0, atomic_fact: 0, agent_case: 0, agent_skill: 0 };

function setupMemories() {
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      loadMemories(currentFilter);
    });
  });

  $('mem-refresh').addEventListener('click', () => loadMemories(currentFilter));
  $('mem-write-btn').addEventListener('click', () => {
    $('write-panel').classList.remove('hidden');
  });
  $('write-backdrop').addEventListener('click', closeWrite);
  $('write-close').addEventListener('click', closeWrite);
  $('write-submit').addEventListener('click', submitWrite);

  loadMemories('all');
}

function closeWrite() {
  $('write-panel').classList.add('hidden');
  $('write-result').className = 'write-result';
}

async function loadMemories(type) {
  const el = $('mem-list');
  el.innerHTML = '<div class="skeleton skeleton--block" style="margin-bottom:8px"></div>'.repeat(5);
  try {
    // 加载当前类型数据
    const data = type === 'all'
      ? await API.get('memories')
      : await API.post('memories-by-type', { memory_type: type, limit: 30 });
    const items = data.data?.data?.items || data.data?.items || [];

    // 同时加载各类型统计数据用于 filter-count
    await loadMemStats();

    if (!items.length) {
      el.innerHTML = '<p class="empty-state">暂无记忆</p>';
      return;
    }
    el.innerHTML = items.map((m, i) => {
      const t = m.memory_type || m.type || 'memory';
      const content = (m.content || m.text || JSON.stringify(m)).slice(0, 150);
      return `
        <div class="mem-item" style="animation-delay:${i * 40}ms">
          <span class="mem-item__type ${escape(t)}">${escape(t)}</span>
          <span class="mem-item__content">${escape(content)}</span>
          <span class="mem-item__time">${fmtTime(m.timestamp || m.created_at)}</span>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="empty-state">加载失败: ${escape(e.message)}</p>`;
  }
}

async function loadMemStats() {
  try {
    // 逐个获取各类型计数
    const types = ['episode', 'atomic_fact', 'agent_case', 'agent_skill'];
    for (const t of types) {
      const data = await API.post('memories-by-type', { memory_type: t, limit: 1 });
      const items = data.data?.data?.items || data.data?.items || [];
      // 尝试从响应中获取 total
      const total = data.data?.data?.total || data.data?.total || items.length;
      memStats[t] = total;
      // 更新 filter-count
      const idMap = { episode: 'f-episode', atomic_fact: 'f-fact', agent_case: 'f-case', agent_skill: 'f-skill' };
      const countEl = $(idMap[t]);
      if (countEl) countEl.textContent = total > 0 ? total : '';
    }
    const allTotal = Object.values(memStats).reduce((a, b) => a + b, 0);
    const allEl = $('f-all');
    if (allEl) allEl.textContent = allTotal > 0 ? allTotal : '';

    // 更新 tab count
    $('tab-count-memories').textContent = allTotal > 0 ? allTotal : '';
  } catch {}
}

async function submitWrite() {
  const type = $('write-type').value;
  const content = $('write-content').value.trim();
  if (!content) { toast('请输入记忆内容', 'error'); return; }

  const result = $('write-result');
  result.className = 'write-result visible';
  result.textContent = '写入中...';
  $('write-submit').disabled = true;

  try {
    const data = await API.post('memorize', {
      content,
      memory_type: type,
      user_id: 'webui',
    });
    if (data.ok || data.status === 'ok') {
      result.className = 'write-result visible success';
      result.textContent = '✓ 写入成功';
      $('write-content').value = '';
      toast('记忆已写入', 'success');
      setTimeout(closeWrite, 1200);
      setTimeout(() => loadMemories(currentFilter), 1500);
    } else {
      result.className = 'write-result visible error';
      result.textContent = `✗ ${data.error || '写入失败'}`;
    }
  } catch (e) {
    result.className = 'write-result visible error';
    result.textContent = `✗ ${e.message}`;
  } finally {
    $('write-submit').disabled = false;
  }
}

// ═══ 检索 ──────────────────────────────────────────────────────

$('search-btn').addEventListener('click', doSearch);
$('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const q = $('search-input').value.trim();
  if (!q) { toast('请输入搜索内容', ''); return; }

  const el = $('search-results');
  el.innerHTML = '<div class="skeleton skeleton--block"></div>'.repeat(3);

  try {
    const data = await API.post('search', { query: q, top_k: 10 });
    const items = data.data?.data?.items || data.results || [];
    if (!items.length) {
      el.innerHTML = '<p class="empty-state">未找到匹配结果</p>';
      return;
    }
    el.innerHTML = items.map((m, i) => {
      const t = m.memory_type || m.type || 'memory';
      const content = (m.content || m.text || '').slice(0, 200);
      const score = m.score || m.relevance || 0;
      const scorePct = typeof score === 'number' ? Math.round(score * 100) : 0;
      return `
        <div class="search-item" style="animation-delay:${i * 50}ms">
          <div class="search-item__head">
            <span class="search-item__type ${escape(t)}">${escape(t)}</span>
            <span class="search-item__score">
              <span class="search-item__score-bar" style="width:40px"><span style="display:block;width:${scorePct}%"></span></span>
              ${scorePct}%
            </span>
          </div>
          <div class="search-item__content">${escape(content)}</div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="empty-state">检索失败: ${escape(e.message)}</p>`;
  }
}

// ═══ 技能库 ────────────────────────────────────────────────────

async function loadSkills() {
  const el = $('skill-grid');
  el.innerHTML = '<div class="skeleton skeleton--block" style="height:80px"></div>'.repeat(4);
  try {
    const data = await API.post('memories-by-type', { memory_type: 'agent_skill', limit: 50 });
    const items = data.data?.data?.items || data.data?.items || [];
    const count = items.length;
    $('skills-count').textContent = count ? `${count} 个技能` : '暂无';
    $('tab-count-skills').textContent = count > 0 ? count : '';

    if (!items.length) {
      el.innerHTML = '<p class="empty-state">还没有积累的技能</p>';
      return;
    }
    el.innerHTML = items.map(m => {
      const name = m.name || (m.content || '').split('\n')[0] || '未命名技能';
      const desc = (m.description || m.content || '').slice(0, 120);
      const icon = ['⚡', '🔧', '🧠', '🛠', '📐', '🎯'][Math.floor(Math.random() * 6)];
      return `
        <div class="skill-card">
          <div class="skill-card__name">
            <span class="skill-card__name-icon">${icon}</span>
            ${escape(name)}
          </div>
          <div class="skill-card__desc">${escape(desc)}</div>
          <div class="skill-card__meta">
            <span>${fmtTime(m.timestamp || m.created_at)}</span>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="empty-state">加载失败: ${escape(e.message)}</p>`;
  }
}

// ═══ 设置 ──────────────────────────────────────────────────────

function setupSettings() {
  try {
    const saved = localStorage.getItem('everos-config');
    if (saved) {
      const cfg = JSON.parse(saved);
      $('set-url').value = cfg.url || '';
      $('set-app').value = cfg.app || '';
      $('set-project').value = cfg.project || '';
    }
  } catch {}

  $('mode-label').textContent = isPlugin ? 'AstrBot 插件内嵌' : '独立服务器';
  $('settings-mode-label').textContent = isPlugin ? '插件内嵌' : '独立服务器';

  if (isPlugin) {
    $('set-url').placeholder = '由插件配置管理';
    $('set-app').placeholder = 'astrbot';
    $('set-project').placeholder = 'default';
    $$('#settings-form input').forEach(i => i.disabled = true);
    $('set-save').style.display = 'none';
    $('set-test').style.display = 'none';
  }

  $('set-save').addEventListener('click', () => {
    const cfg = {
      url: $('set-url').value.trim(),
      app: $('set-app').value.trim(),
      project: $('set-project').value.trim(),
    };
    try { localStorage.setItem('everos-config', JSON.stringify(cfg)); } catch {}
    $('set-result').className = 'set-result visible';
    $('set-result').textContent = '✓ 已保存到本地';
    toast('配置已保存', 'success');
  });

  $('set-test').addEventListener('click', async () => {
    $('set-result').className = 'set-result visible';
    $('set-result').textContent = '测试中...';
    try {
      const data = await API.get('status');
      if (data.healthy) {
        $('set-result').textContent = `✓ 连接成功！延迟 ${data.latency || '?'}ms，总计 ${Object.values(data.stats || {}).reduce((a,b) => a + (b > 0 ? b : 0), 0)} 条记忆`;
        toast('连接成功', 'success');
      } else {
        $('set-result').textContent = `✗ 连接失败: ${data.error || '服务不可用'}`;
        toast('连接失败', 'error');
      }
    } catch (e) {
      $('set-result').textContent = `✗ ${e.message}`;
      toast('连接失败', 'error');
    }
  });
}

// ═══ 标签切换 ──────────────────────────────────────────────────

function setupTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add('active');

      switch (tab.dataset.tab) {
        case 'memories': if (!$('mem-list').querySelector('.mem-item')) loadMemories(currentFilter); break;
        case 'skills': loadSkills(); break;
      }
    });
  });
}

// ═══ 启动 ──────────────────────────────────────────────────────

async function init() {
  log(`模式: ${isPlugin ? 'AstrBot 插件内嵌' : '独立服务器'}`);

  if (isPlugin) {
    try { await window.AstrBotPluginPage.ready(); } catch (e) { log('bridge.ready 失败', e); }
  }

  // 显示页面
  $('app').classList.remove('loading');

  // 初始化各模块
  setupTabs();
  setupMemories();
  setupSettings();
  setupQuickActions();

  // 加载总览
  await loadOverview();

  // 定时刷新
  setInterval(async () => {
    const active = document.querySelector('.tab.active');
    if (active && active.dataset.tab === 'overview') {
      await loadOverview();
    }
  }, 15000);

  log('初始化完成');
}

// 挂载全局
window.__everos = { API, refresh: loadOverview };

init().catch(e => {
  console.error('[EverOS] 初始化失败', e);
  document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">
    <h2>初始化失败</h2>
    <pre style="margin-top:16px;font-size:13px">${e.message}</pre>
  </div>`;
});
