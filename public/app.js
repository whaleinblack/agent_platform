(() => {
  "use strict";

  // Keep browser authorization on one host; API clients keep their original URLs.
  if (location.protocol === "http:" && ["127.0.0.1", "agents"].includes(location.hostname)) {
    const canonical = new URL(location.href);
    canonical.hostname = "localhost";
    location.replace(canonical.href);
    return;
  }

  if (!window.AgentCoordinatorTheme) {
    const storageKey = "agent-coordinator.theme";
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const validMode = value => ["dark", "light", "system"].includes(value) ? value : "dark";
    let mode;
    let resolved;

    function readMode() {
      try { return validMode(localStorage.getItem(storageKey)); }
      catch { return "dark"; }
    }
    function apply(value) {
      const nextMode = validMode(value);
      const nextResolved = nextMode === "system" ? (media.matches ? "dark" : "light") : nextMode;
      const changed = mode !== nextMode || resolved !== nextResolved;
      mode = nextMode;
      resolved = nextResolved;
      root.setAttribute("data-theme", resolved);
      root.setAttribute("data-theme-mode", mode);
      document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolved);
      if (changed) window.dispatchEvent(new CustomEvent("agent-coordinator-themechange", {detail: {mode, resolved}}));
    }

    apply(readMode());
    window.AgentCoordinatorTheme = Object.freeze({
      storageKey,
      get mode() { return mode; },
      get resolved() { return resolved; },
      setMode(value) {
        const nextMode = validMode(value);
        try { localStorage.setItem(storageKey, nextMode); }
        catch { /* Storage may be unavailable; keep this tab usable. */ }
        apply(nextMode);
      }
    });

    window.addEventListener("storage", event => {
      if (event.key !== storageKey && event.key !== null) return;
      try { if (event.storageArea !== localStorage) return; }
      catch { return; }
      apply(event.key === null ? "dark" : event.newValue);
    });
    const followSystem = () => { if (mode === "system") apply(mode); };
    if (media.addEventListener) media.addEventListener("change", followSystem);
    else media.addListener(followSystem);
  }
  // The blocking head load initializes only the theme, not auth or body controls.
  if (document.currentScript?.hasAttribute("data-theme-bootstrap")) return;

  function takeOwnerTicket() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (!fragment.has("owner")) return null;
    const ticket = fragment.get("owner");
    fragment.delete("owner");
    const remaining = fragment.toString();
    history.replaceState(history.state, "", window.location.pathname + window.location.search + (remaining ? `#${remaining}` : ""));
    return ticket;
  }
  let ownerTicket = takeOwnerTicket();
  const $ = id => document.getElementById(id);
  const catalog = JSON.parse($("i18n-catalog").textContent);
  const languageKey = "agent-coordinator.language";
  const locales = {zh: "zh-CN", ja: "ja-JP", en: "en-US"};
  const validLanguage = value => Object.hasOwn(locales, value) ? value : "zh";
  let language = "zh";
  try { language = validLanguage(localStorage.getItem(languageKey)); } catch {}
  const uiSources = new Map();
  function t(source, values = {}) {
    if (source && typeof source === "object") return t(source.key, source.values);
    const key = String(source ?? ""), entry = catalog[key];
    const text = language === "zh" ? entry?.[2] || key : entry?.[language === "ja" ? 0 : 1] || key;
    return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  }
  const message = (key, values = {}) => ({key, values});
  // Bind only the original UI. Agent-authored data and user input are never translated.
  const staticBindings = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    if (node.parentElement?.closest('script, style, noscript, textarea, [translate="no"]')) continue;
    const key = node.nodeValue.trim();
    if (Object.hasOwn(catalog, key)) staticBindings.push({node, key, before: node.nodeValue.match(/^\s*/)[0], after: node.nodeValue.match(/\s*$/)[0]});
  }
  for (const node of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const key = node.getAttribute(attr);
      if (key && Object.hasOwn(catalog, key)) staticBindings.push({node, attr, key});
    }
  }
  function applyLanguage() {
    document.documentElement.lang = locales[language];
    for (const binding of staticBindings) {
      if (!binding.node.isConnected) continue;
      if (binding.attr) binding.node.setAttribute(binding.attr, t(binding.key));
      else binding.node.nodeValue = binding.before + t(binding.key) + binding.after;
    }
    for (const [node, source] of uiSources) {
      if (node.isConnected) node.textContent = t(source);
      else uiSources.delete(node);
    }
    $("language-select").value = language;
    for (const control of document.querySelectorAll('input, textarea')) {
      if (control.validity.customError) control.setCustomValidity(t("请填写此字段。"));
    }
  }
  const list = value => Array.isArray(value) ? value : [];
  const active = agent => ["working", "waiting"].includes(agent.status);
  const statusNames = {working: "工作中", waiting: "等待中", completed: "已完成", idle: "已空闲", failed: "失败", cancelled: "已取消", timed_out: "已超时"};
  const eventNames = {"project.created": "项目已创建", "agent.joined": "Agent 已加入", "agent.updated": "会话已更新", "message.sent": "消息已发送", "note.posted": "公告已发布", "project.updated": "项目设置已更新", "project.deleted": "项目已归档", "rules.updated": "规则已更新", "rules.confirmed": "规则已确认", "rules.granted": "已授予规则修改授权", "rules.grantRevoked": "已撤销规则修改授权"};
  const state = {
    token: "", projects: [], projectsLoaded: false, selectedId: "", snapshots: new Map(),
    selectedSession: "", tab: "agents", busy: false, queued: false, timer: null,
    syncError: "", lastSync: null, ownerSignInRequired: false, ownerSignInError: "", messagePending: false, projectPending: false,
    notePending: false, cancelPending: false, noteProjectId: "", cancelAgent: null,
    messageDrafts: new Map(), noteDrafts: new Map(), policyPending: new Set(), policyFeedback: new Map()
  };
  const iconCache = new Map();
  let dateFormat, timeFormat, relativeFormat;
  function updateFormats() {
    dateFormat = new Intl.DateTimeFormat(locales[language], {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
    timeFormat = new Intl.DateTimeFormat(locales[language], {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
    relativeFormat = new Intl.RelativeTimeFormat(locales[language], {numeric: "always"});
  }
  updateFormats();

  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
  }
  function setText(id, value, raw = false) {
    const node = $(id), text = raw ? String(value ?? "") : t(value);
    if (raw) uiSources.delete(node);else uiSources.set(node, value);
    if (node.textContent !== text) node.textContent = text;
  }
  function icon(name) {
    if (!iconCache.has(name)) {
      const holder = document.createElement("span");
      holder.innerHTML = `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`;
      window.lucide?.createIcons({root: holder});
      iconCache.set(name, holder.innerHTML);
    }
    return iconCache.get(name);
  }
  function stamp(value) {
    const result = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function date(value) { const time = stamp(value); return time === null ? t("未知时间") : dateFormat.format(time); }
  function relative(value) {
    const time = stamp(value);
    if (time === null) return t("未记录");
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 5) return t("刚刚");
    if (seconds < 60) return relativeFormat.format(-seconds, "second");
    if (seconds < 3600) return relativeFormat.format(-Math.floor(seconds / 60), "minute");
    if (seconds < 86400) return relativeFormat.format(-Math.floor(seconds / 3600), "hour");
    return relativeFormat.format(-Math.floor(seconds / 86400), "day");
  }
  function duration(ms) {
    if (!Number.isFinite(ms)) return t("未设置");
    return ms >= 60000 && ms % 60000 === 0 ? t("{n} 分钟", {n: ms / 60000}) : t("{n} 秒", {n: ms / 1000});
  }
  function snapshot() { return state.snapshots.get(state.selectedId); }
  function selectedProject() { return state.projects.find(project => project.id === state.selectedId) || snapshot()?.project; }
  function matches(query, ...values) { return values.flat(Infinity).join("\n").toLowerCase().includes(query.trim().toLowerCase()); }
  function newest(items, field = "createdAt") {
    return [...items].reverse().sort((a, b) => (stamp(b[field]) ?? 0) - (stamp(a[field]) ?? 0));
  }

  // Keyed updates keep focused controls, expanded event details and scroll positions intact.
  function morph(target, source) {
    if (target.nodeType !== source.nodeType || target.nodeName !== source.nodeName) {
      target.replaceWith(source.cloneNode(true));
      return;
    }
    if (target.nodeType === Node.TEXT_NODE) {
      if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
      return;
    }
    if (target.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of [...target.attributes]) {
      if (attr.name === "open" && target.tagName === "DETAILS") continue;
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    }
    for (const attr of source.attributes) {
      if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    }
    const incoming = [...source.childNodes];
    for (let index = 0; index < incoming.length; index++) {
      if (target.childNodes[index]) morph(target.childNodes[index], incoming[index]);
      else target.append(incoming[index].cloneNode(true));
    }
    while (target.childNodes.length > incoming.length) target.lastChild.remove();
  }
  function markup(node, html) {
    if (node._markup === html) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const shell = node.cloneNode(false);
    shell.append(template.content);
    morph(node, shell);
    node._markup = html;
  }
  function reconcile(container, items, make, update) {
    const existing = new Map([...container.children].map(node => [node.dataset.key, node]));
    const used = new Set();
    items.forEach((item, index) => {
      const key = String(item.id);
      if (used.has(key)) return;
      used.add(key);
      const node = existing.get(key) || make(item);
      node.dataset.key = key;
      update(node, item);
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    for (const [key, node] of existing) if (!used.has(key)) node.remove();
  }
  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  class ApiError extends Error {
    constructor(source, status, ownerSignInRequired = false) { super(t(source)); this.source = source; this.status = status; this.ownerSignInRequired = ownerSignInRequired; }
  }
  function requireOwnerSignIn() {
    clearTimeout(state.timer);
    state.timer = null;
    state.queued = false;
    state.token = "";
    state.ownerSignInRequired = true;
    state.syncError = "";
    renderConnection();
  }
  function cleanError(error) {
    let message = error?.source || error?.message || "请求失败，请稍后重试。";
    if (state.token && typeof message === "string") message = message.split(state.token).join("[已隐藏]");
    return message;
  }
  async function api(path, {method = "GET", body} = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const headers = {Accept: "application/json"};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: "no-store", credentials: "same-origin"});
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 || data?.ownerSignInRequired === true) {
          requireOwnerSignIn();
          throw new ApiError("需要管理员登录", response.status, true);
        }
        const detail = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
        const failure = new ApiError(detail || message("请求失败（{status}）", {status: response.status}), response.status);
        failure.code = typeof data?.code === "string" ? data.code : "";
        throw failure;
      }
      if (data === null) throw new ApiError("服务器返回了无效的数据。", response.status);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("请求超时，请检查本地服务。", 0);
      if (error instanceof TypeError) throw new ApiError("无法连接本地服务，请检查服务是否已启动。", 0);
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function bootstrap() {
    let result;
    if (ownerTicket !== null) {
      const ticket = ownerTicket;
      ownerTicket = null;
      try { result = await api("/api/owner/session", {method: "POST", body: {ticket}}); }
      catch (error) {
        if (error.ownerSignInRequired || [401, 403].includes(error.status)) {
          requireOwnerSignIn();
          state.ownerSignInError = "启动授权已失效，请重新运行启动器。";
          throw new ApiError("需要管理员登录", error.status, true);
        }
        throw new ApiError("无法完成管理员授权，请检查本地服务后重新运行启动器。", error.status);
      }
    } else result = await api("/api/bootstrap");
    if (typeof result.token !== "string" || !result.token) throw new ApiError("服务未返回管理员凭据。", 0);
    state.token = result.token;
    state.ownerSignInRequired = false;
    state.ownerSignInError = "";
    if (!state.projectsLoaded && Array.isArray(result.snapshot?.projects)) {
      state.projects = result.snapshot.projects;
      state.projectsLoaded = true;
      if (!state.selectedId && state.projects.length) selectProject(state.projects[0].id, false);
      render();
    }
  }
  async function sync() {
    if (state.busy) { state.queued = true; return; }
    clearTimeout(state.timer);
    state.busy = true;
    renderConnection();
    try {
      if (!state.token) await bootstrap();
      const result = await api("/api/projects");
      if (!Array.isArray(result.projects)) throw new ApiError("项目列表格式无效。", 0);
      state.projects = result.projects;
      state.projectsLoaded = true;
      if (!state.selectedId || !state.projects.some(project => project.id === state.selectedId)) {
        selectProject(state.projects[0]?.id || "", false);
      }
      render();
      const projectId = state.selectedId;
      if (projectId) {
        const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
        if (!data.project || data.project.id !== projectId || !["agents", "messages", "notes", "events"].every(key => Array.isArray(data[key]))) {
          throw new ApiError("项目快照格式无效。", 0);
        }
        state.snapshots.set(projectId, data);
      }
      state.syncError = "";
      state.lastSync = Date.now();
    } catch (error) {
      if (error.ownerSignInRequired) requireOwnerSignIn();
      else {
        state.syncError = cleanError(error);
        if (error.status === 403) state.token = "";
      }
    } finally {
      state.busy = false;
      render();
      // All automatic and manual refreshes share this one single-flight scheduler.
      const delay = state.queued ? 0 : 2000;
      state.queued = false;
      state.timer = state.ownerSignInRequired ? null : setTimeout(sync, delay);
    }
  }
  function requestSync() { clearTimeout(state.timer); void sync(); }

  function saveMessageDraft() {
    if (!state.selectedId) return;
    state.messageDrafts.set(state.selectedId, {
      recipient: $("message-recipient").value, text: $("message-text").value,
      kind: $("message-form").elements.kind.value,
      feedback: uiSources.get($("message-feedback")) ?? $("message-feedback").textContent, feedbackClass: $("message-feedback").className
    });
  }
  function loadMessageDraft() {
    const draft = state.messageDrafts.get(state.selectedId);
    $("message-recipient").value = draft?.recipient ?? "*";
    $("message-text").value = draft?.text ?? "";
    $("message-form").elements.kind.value = draft?.kind ?? "message";
    setText("message-feedback", draft?.feedback ?? "");
    $("message-feedback").className = draft?.feedbackClass ?? "form-feedback";
    clearValidation($("message-form"));
  }
  function saveNoteDraft() {
    if (!state.noteProjectId) return;
    state.noteDrafts.set(state.noteProjectId, {title: $("note-title").value, text: $("note-text").value, tags: $("note-tags").value});
  }
  function selectProject(id, refresh = true) {
    if (state.selectedId === id) return;
    saveMessageDraft();
    if ($("note-dialog").open && !state.notePending) { saveNoteDraft(); $("note-dialog").close(); }
    if ($("cancel-dialog").open && !state.cancelPending) $("cancel-dialog").close();
    state.selectedId = id;
    state.selectedSession = "";
    loadMessageDraft();
    render();
    if (refresh) requestSync();
  }

  function renderConnection() {
    const connected = !!state.lastSync && !state.syncError && !state.ownerSignInRequired;
    $("connection-dot").className = `connection-dot ${state.ownerSignInRequired ? "owner-required" : state.syncError ? "error" : connected ? "connected" : ""}`;
    setText("connection-text", state.ownerSignInRequired ? "需要管理员登录" : state.syncError ? "连接中断" : connected ? "已连接" : "正在连接");
    $("refresh-button").classList.toggle("is-syncing", state.busy);
    $("refresh-button").setAttribute("aria-busy", String(state.busy));
    $("owner-sign-in").hidden = !state.ownerSignInRequired;
    setText("owner-sign-in-error", state.ownerSignInError);
    $("owner-sign-in-error").hidden = !state.ownerSignInError;
    $("sync-error").hidden = !state.syncError || state.ownerSignInRequired;
    setText("sync-error-text", state.syncError ? message("{error} 将自动重试。", {error: t(state.syncError)}) : "");
    setText("last-sync", state.ownerSignInRequired ? "等待管理员登录" : state.lastSync ? message("同步于 {time}", {time: timeFormat.format(state.lastSync)}) : "尚未同步");
    $("project-list").setAttribute("aria-busy", String(!state.projectsLoaded && !state.ownerSignInRequired));
    const hasProject = !!state.selectedId && !!snapshot();
    $("message-fields").disabled = !state.token || !hasProject || state.messagePending;
    $("create-project-button").disabled = !state.token || state.projectPending;
    $("publish-note-button").disabled = !state.token || state.notePending;
    $("confirm-cancel-button").disabled = !state.token || state.cancelPending;
    $("project-settings-button").disabled = !state.token || !state.selectedId;
    $("policy-button").disabled = !state.token || state.policyPending.has(state.selectedId);
    $("policy-button").setAttribute("aria-busy", String(state.policyPending.has(state.selectedId)));
    $("policy-button").querySelector("span").textContent = t(state.policyPending.has(state.selectedId) ? "写入中…" : "接入规则");
    for (const button of document.querySelectorAll('[data-action="open-project"]')) button.disabled = !state.token;
    for (const button of document.querySelectorAll('[data-action="open-note"], [data-action="cancel-session"]')) button.disabled = !state.token || !hasProject;
  }
  function renderProjects() {
    const query = $("project-search").value;
    const visible = state.projects.filter(project => matches(query, project.name, project.root, project.description));
    setText("project-count", state.projects.length);
    reconcile($("project-list"), visible, () => element("button", "project-button"), (node, project) => {
      node.type = "button";
      node.dataset.projectId = project.id;
      node.title = `${project.name}\n${project.root}`;
      if (project.id === state.selectedId) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
      markup(node, `${icon("folder")}<span><strong>${escape(project.name)}</strong><small>${escape(project.root)}</small></span>`);
    });
    $("project-empty").hidden = visible.length > 0;
    setText("project-empty", state.ownerSignInRequired && !state.projectsLoaded ? "等待管理员登录" : !state.projectsLoaded ? (state.syncError ? "项目暂不可用" : "正在加载项目…") : state.projects.length === 0 ? "暂无项目" : "没有匹配的项目");
  }
  function renderHeading() {
    const project = selectedProject();
    const data = snapshot();
    setText("project-title", project?.name || t("选择项目"), true);
    setText("project-root", project?.root || "", true);
    setText("project-description", project?.description || "", true);
    $("project-description").hidden = !project?.description;
    setText("project-settings", project ? message("租约 {lease} · 空闲 {idle}", {lease: duration(project.leaseMs), idle: duration(project.idleMs)}) : "");
    $("policy-button").hidden = !project;
    $("project-settings-button").hidden = !project;
    if ($("settings-dialog").open) updateSettingsState();
    const policyFeedback = state.policyFeedback.get(state.selectedId);
    $("policy-feedback").hidden = !policyFeedback;
    setText("policy-feedback", policyFeedback?.policy ? policyResultText(policyFeedback.policy, policyFeedback.created) : policyFeedback?.text || "");
    $("policy-feedback").className = `policy-feedback ${policyFeedback?.type || ""}`;
    $("project-workspace").hidden = !project;
    $("welcome").hidden = !!project;
    setText("welcome-title", state.ownerSignInRequired ? "管理员工作区" : state.syncError && !state.projectsLoaded ? "工作区暂不可用" : !state.projectsLoaded ? "正在连接工作区" : "暂无项目");
    setText("welcome-text", state.ownerSignInRequired ? "登录后显示项目和会话。" : state.syncError && !state.projectsLoaded ? "请检查本地服务连接。" : !state.projectsLoaded ? "正在获取项目数据…" : "项目列表为空。");
    $("agent-table-wrap").setAttribute("aria-busy", String(!!project && !data));
  }
  function badge(status) {
    return `<span class="badge ${escape(Object.hasOwn(statusNames, status) ? status : "")}">${escape(t(statusNames[status] || status || "未知状态"))}</span>`;
  }
  function lease(agent) {
    if (!active(agent)) return t("已结束");
    const time = stamp(agent.leaseExpiresAt);
    if (time === null) return t("租约未记录");
    const seconds = Math.ceil((time - Date.now()) / 1000);
    return seconds <= 0 ? t("租约已过期") : t("租约剩余 {n} 秒", {n: seconds});
  }
  function progressMarkup(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const percent = Math.min(100, Math.max(0, value));
      return `<span class="progress-value">${escape(value)}%</span><progress class="numeric-progress" value="${percent}" max="100" aria-label="${t("进度")} ${escape(value)}%"></progress>`;
    }
    return `<span class="progress-value" title="${escape(value || t("未更新"))}">${escape(value || t("未更新"))}</span>`;
  }
  function renderAgents() {
    const data = snapshot(), agents = list(data?.agents), query = $("agent-search").value;
    const visible = agents.filter(agent => ($("show-history").checked || active(agent)) && matches(query, agent.agentId, agent.task, agent.progress, agent.id, list(agent.files)));
    visible.sort((a, b) => Number(active(b)) - Number(active(a)) || (stamp(b.joinedAt) ?? 0) - (stamp(a.joinedAt) ?? 0));
    setText("stat-working", agents.filter(agent => agent.status === "working").length);
    setText("stat-waiting", agents.filter(agent => agent.status === "waiting").length);
    const conflicts = agents.filter(agent => active(agent) && list(agent.conflicts).length > 0).length;
    setText("stat-conflicts", conflicts);
    $("stat-conflicts").classList.toggle("has-conflict", conflicts > 0);
    $("stat-conflicts").title = t("存在文件冲突的活动会话数");
    setText("stat-total", agents.length);
    setText("agents-count", agents.filter(active).length);
    reconcile($("agent-rows"), visible, () => element("tr"), (node, agent) => {
      node.classList.toggle("selected", agent.id === state.selectedSession);
      const conflictCount = list(agent.conflicts).length;
      const expired = active(agent) && stamp(agent.leaseExpiresAt) !== null && stamp(agent.leaseExpiresAt) <= Date.now();
      markup(node, `<td><button type="button" class="agent-name" data-action="select-session" data-session-id="${escape(agent.id)}" aria-expanded="${agent.id === state.selectedSession}" aria-controls="session-detail">${escape(agent.agentId)}</button><div class="task-summary" title="${escape(agent.task)}">${escape(agent.task)}</div></td>
        <td>${badge(agent.status)}</td><td>${progressMarkup(agent.progress)}</td>
        <td><div class="file-count">${icon("files")}<span>${list(agent.files).length}</span></div><div class="lease">${t("申领 {n}", {n: list(agent.claimedFiles).length})}</div>${conflictCount ? `<button type="button" class="conflict-link" data-action="select-session" data-session-id="${escape(agent.id)}">${t("{n} 处冲突", {n: conflictCount})}</button>` : ""}</td>
        <td><div class="heartbeat" title="${escape(date(agent.lastHeartbeatAt))}">${escape(relative(agent.lastHeartbeatAt))}</div><div class="lease ${expired ? "expired" : ""}">${escape(lease(agent))}</div></td>
        <td class="row-actions">${active(agent) ? `<button type="button" class="icon-button" data-action="cancel-session" data-session-id="${escape(agent.id)}" title="${escape(t("终止 {agent} 的会话", {agent: agent.agentId}))}" aria-label="${escape(t("终止 {agent} 的会话", {agent: agent.agentId}))}">${icon("square")}</button>` : ""}</td>`);
    });
    $("agent-empty").hidden = visible.length > 0;
    setText("agent-empty", !data ? (state.syncError ? "会话暂不可用，正在重试…" : "正在加载会话…") : query ? "没有匹配的会话" : agents.length === 0 ? "暂无 Agent 会话" : !$("show-history").checked ? "暂无活动会话" : "暂无会话");
    const selected = agents.find(agent => agent.id === state.selectedSession);
    if (!selected) state.selectedSession = "";
    $("session-detail").hidden = !selected;
    if (selected) renderDetail(selected);
  }
  function fileMarkup(files) {
    return files.length ? `<ul class="file-list">${files.map(file => `<li>${icon("file-code")}${escape(file)}</li>`).join("")}</ul>` : `<p class="subtle-empty">${t("无")}</p>`;
  }
  function renderDetail(agent) {
    const conflicts = list(agent.conflicts);
    markup($("session-detail"), `<div class="detail-header"><div><h2>${escape(agent.agentId)} ${badge(agent.status)}</h2><p class="detail-id">${escape(agent.id)}</p></div><button type="button" class="icon-button" data-action="close-detail" aria-label="${t("关闭会话详情")}" title="${t("关闭详情")}">${icon("x")}</button></div>
      <p class="detail-task">${escape(agent.task)}</p><div class="detail-progress">${progressMarkup(agent.progress)}</div>
      <div class="detail-times"><span>${t("心跳")} ${escape(date(agent.lastHeartbeatAt))}</span><span>${t("最近活动")} ${escape(date(agent.lastActivityAt))}</span><span>${t("租约到期")} ${escape(date(agent.leaseExpiresAt))}</span>${agent.endedAt ? `<span>${t("结束")} ${escape(date(agent.endedAt))}</span>` : ""}</div>
      <div class="detail-files"><div><h3>${t("声明文件")} · ${list(agent.files).length}</h3>${fileMarkup(list(agent.files))}</div><div><h3>${t("当前申领")} · ${list(agent.claimedFiles).length}</h3>${fileMarkup(list(agent.claimedFiles))}</div>
      <div class="detail-conflicts"><h3>${t("冲突会话")} · ${conflicts.length}</h3>${conflicts.length ? conflicts.map(conflict => `<div class="conflict-item"><strong>${escape(conflict.agentId)}</strong><p class="conflict-session">${escape(conflict.sessionId)}</p>${fileMarkup(list(conflict.files))}</div>`).join("") : `<p class="subtle-empty">${t("无文件冲突")}</p>`}</div></div>
      ${agent.summary ? `<div class="detail-summary"><h3>${t("交接说明")}</h3><p class="detail-task">${escape(agent.summary)}</p></div>` : ""}`);
  }
  const noteWeekOpen = new Map();
  const noteDayFormat = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"});
  function noteWeek(value) {
    const timestamp = stamp(value);
    if (timestamp === null) return {id: "undated", label: t("日期未知")};
    // Convert to the project's local calendar day before calculating Monday.
    const parts = Object.fromEntries(noteDayFormat.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    const monday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const start = monday.toISOString().slice(0, 10), end = sunday.toISOString().slice(0, 10);
    return {id: start, label: `${start} ～ ${end}`};
  }
  function renderNotes() {
    const data = snapshot(), notes = newest(list(data?.notes)), query = $("note-search").value;
    const noteTime = new Intl.DateTimeFormat(locales[language], {timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false});
    const visible = notes.filter(note => matches(query, note.title, note.text, list(note.tags), note.authorAgentId));
    setText("notes-count", notes.length);
    const groups = new Map();
    for (const note of visible) {
      const week = noteWeek(note.createdAt);
      if (!groups.has(week.id)) groups.set(week.id, {...week, notes: []});
      groups.get(week.id).notes.push(note);
    }
    const weeks = [...groups.values()].sort((a, b) => a.id === "undated" ? 1 : b.id === "undated" ? -1 : b.id.localeCompare(a.id));
    reconcile($("note-list"), weeks.map(week => ({...week, weekId: week.id, id: `${state.selectedId}:${week.id}`})), week => {
      const node = element("details", "note-week"), summary = element("summary", "note-week-heading");
      node.append(summary, element("div", "note-week-items"));
      summary.addEventListener("click", event => {
        event.preventDefault();
        node.open = !node.open;
        noteWeekOpen.set(node._openKey, node.open);
      });
      return node;
    }, (node, week) => {
      const search = query.trim().toLowerCase();
      node._openKey = JSON.stringify([week.id, search]);
      node.open = noteWeekOpen.has(node._openKey) ? noteWeekOpen.get(node._openKey) : !!search || week.weekId === weeks[0]?.id;
      node.dataset.week = week.weekId;
      markup(node.firstElementChild, `${icon("chevron-right")}${icon("folder")}<span class="note-week-label">${escape(week.label)}</span><span class="count">${escape(t("{n} 条公告", {n: week.notes.length}))}</span>`);
      reconcile(node.lastElementChild, week.notes, () => element("article", "note-item"), (item, note) => markup(item, `<h3>${escape(note.title)}</h3><div class="note-meta"><span>${escape(note.authorAgentId)}</span><time>${escape(stamp(note.createdAt) === null ? t("未知时间") : noteTime.format(stamp(note.createdAt)))}</time></div><p class="note-body">${escape(note.text)}</p>${list(note.tags).length ? `<div class="tags">${note.tags.map(tag => `<span class="tag">${escape(tag)}</span>`).join("")}</div>` : ""}`));
    });
    $("note-empty").hidden = visible.length > 0;
    setText("note-empty", !data ? "正在加载公告…" : query ? "没有匹配的公告" : "暂无公告");
  }
  function deliveryMarkup(message) {
    const delivered = list(message.deliveredTo);
    return delivered.length ? `<p class="delivery">${t("已确认接收")} · ${delivered.map(escape).join(language === "en" ? ", " : "、")}</p>` : `<p class="delivery pending">${t("等待接收确认")}</p>`;
  }
  function recipientName(id) { return id === "*" ? t("所有 Agent") : id; }
  function messageMarkup(message, recent = false) {
    if (recent) return `<div class="recent-meta"><strong>${escape(message.fromAgentId)}</strong>${icon("arrow-right")}<strong>${escape(recipientName(message.toAgentId))}</strong>${message.kind === "schedule" ? `<span class="badge">${t("调度")}</span>` : ""}</div><p>${escape(message.text)}</p><time>${escape(date(message.createdAt))}</time>`;
    return `<div class="message-meta"><strong>${escape(message.fromAgentId)}</strong>${icon("arrow-right")}<strong>${escape(recipientName(message.toAgentId))}</strong><span class="badge">${t(message.kind === "schedule" ? "调度" : "消息")}</span><time>${escape(date(message.createdAt))}</time></div><p class="message-body">${escape(message.text)}</p>${deliveryMarkup(message)}`;
  }
  function renderMessages() {
    const data = snapshot(), messages = newest(list(data?.messages)), query = $("message-search").value, filter = $("message-filter").value;
    const visible = messages.filter(message => (filter === "all" || message.kind === filter) && matches(query, message.text, message.fromAgentId, message.toAgentId, list(message.deliveredTo)));
    setText("messages-count", messages.length);
    setText("recent-count", messages.length);
    reconcile($("message-list"), visible, () => element("article", "message-item"), (node, message) => markup(node, messageMarkup(message)));
    reconcile($("recent-messages"), messages.slice(0, 4), () => element("article", "recent-item"), (node, message) => markup(node, messageMarkup(message, true)));
    $("message-empty").hidden = visible.length > 0;
    $("recent-empty").hidden = messages.length > 0;
    setText("message-empty", !data ? "正在加载消息…" : query || filter !== "all" ? "没有匹配的消息" : "暂无消息");
    const recipients = new Set(["*"]);
    for (const agent of list(data?.agents)) if (agent.agentId) recipients.add(agent.agentId);
    for (const message of messages) if (message.toAgentId) recipients.add(message.toAgentId);
    reconcile($("recipient-options"), [...recipients].map(id => ({id})), () => element("option"), (node, item) => { node.value = item.id; node.label = recipientName(item.id); });
  }
  function safeData(value) {
    return JSON.stringify(value, (key, data) => /token|authorization|password|secret|credential/i.test(key) ? t("[已隐藏]") : data, 2)?.split(state.token || "\u0000").join(t("[已隐藏]")) || "{}";
  }
  function eventName(event) {
    if (event.type === "agent.left") return t("会话状态：{status}", {status: t(statusNames[event.data?.status] || "已结束")});
    return t(eventNames[event.type] || event.type);
  }
  function renderEvents() {
    const data = snapshot(), query = $("event-search").value;
    const visible = newest(list(data?.events), "at").filter(event => matches(query, eventName(event), event.type, safeData(event.data)));
    reconcile($("event-list"), visible, () => element("li", "event-item"), (node, event) => {
      const name = eventName(event);
      const subject = event.data?.agentId || event.data?.title || event.data?.name || "";
      markup(node, `<div class="event-icon">${icon(event.type === "message.sent" ? "message-square" : event.type === "note.posted" ? "pin" : "activity")}</div><div><h3>${escape(name)}${subject ? ` · ${escape(subject)}` : ""}</h3><time>${escape(date(event.at))}</time><details><summary>${t("事件详情")}</summary><pre>${escape(safeData(event.data))}</pre></details></div>`);
    });
    $("event-empty").hidden = visible.length > 0;
    setText("event-empty", !data ? "正在加载活动…" : query ? "没有匹配的活动" : "暂无活动");
  }
  function render() {
    renderProjects();
    renderHeading();
    renderAgents();
    renderNotes();
    renderMessages();
    renderEvents();
    renderConnection();
    roadmapUI?.render(state.selectedId,snapshot(),state.token,language,state.tab==='roadmap');
    renderRules();
  }

  function selectTab(name, focus = false) {
    state.tab = name;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === name;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`panel-${button.dataset.tab}`).hidden = !selected;
      if (selected && focus) button.focus();
    }
    roadmapUI?.render(state.selectedId,snapshot(),state.token,language,state.tab==='roadmap');
    renderRules();
  }
  function feedback(id, text, type = "") {
    setText(id, text);
    $(id).className = `form-feedback ${type}`.trim();
  }
  function announce(text) { setText("announcement", text); }
  function renderThemeControl() {
    const theme = window.AgentCoordinatorTheme;
    if (!theme) return;
    $("theme-select").value = theme.mode;
    markup($("theme-icon"), icon("sun-moon"));
    $("theme-select").closest(".theme-control").title = `${t(theme.mode === "system" ? "跟随系统" : "主题")} · ${t(theme.resolved === "dark" ? "深色" : "浅色")}`;
  }
  function clearValidation(form) {
    for (const control of form.querySelectorAll("input, textarea")) control.setCustomValidity("");
  }
  function validate(form) {
    for (const control of form.querySelectorAll("[required]")) {
      control.setCustomValidity(control.value.trim() ? "" : t("请填写此字段。"));
    }
    return form.reportValidity();
  }
  function setPending(formId, fieldsId, buttonId, pending, label, feedbackId) {
    $(formId).setAttribute("aria-busy", String(pending));
    $(fieldsId).disabled = pending;
    $(buttonId).disabled = pending;
    const span = $(buttonId).querySelector("span");
    if (span) { uiSources.set(span, label);span.textContent = t(label); }
    for (const button of $(formId).querySelectorAll('[data-action^="close-"]')) button.disabled = pending;
    if (pending) feedback(feedbackId, "正在提交…");
  }
  function closeDialog(id, pending) { if (!pending) $(id).close(); }
  function openProject() {
    feedback("project-feedback", "");
    $("project-dialog").showModal();
  }

  // Project settings and archive-style deletion. Drafts survive polling; closing a changed draft asks first.
  const settingsFields = [["name", "name"], ["description", "description"], ["root", "root"], ["page", "pageAddress"], ["repository", "repositoryPath"]];
  const revisionConflict = "Project settings changed. Reopen settings and retry.";
  let settingsProject = null, settingsBaseline = "", settingsPending = false, deleteTarget = null, deletePending = false, contextProject = "", contextTrigger = null;
  const menu = $("project-context-menu");
  const activeCount = id => list(state.snapshots.get(id)?.agents).filter(active).length;
  async function latestProject(id) {
    const result = await api("/api/projects");
    if (!Array.isArray(result.projects)) throw new ApiError("项目列表格式无效。", 0);
    state.projects = result.projects;
    state.projectsLoaded = true;
    render();
    return state.projects.find(project => project.id === id) || null;
  }

  function closeProjectMenu(restore = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restore) contextTrigger?.focus();
  }
  function showProjectMenu(node, x, y) {
    if (!state.token) return;
    contextProject = node.dataset.projectId;
    contextTrigger = node;
    menu.hidden = false;
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + "px";
    menu.querySelector("button").focus();
  }
  $("project-list").addEventListener("contextmenu", event => {
    const node = event.target.closest("[data-project-id]");
    if (!node || !state.token) return;
    event.preventDefault();
    showProjectMenu(node, event.clientX, event.clientY);
  });
  $("project-list").addEventListener("keydown", event => {
    const node = event.target.closest("[data-project-id]");
    if (!node || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    showProjectMenu(node, rect.left + 8, rect.bottom + 4);
  });
  document.addEventListener("click", event => { if (!menu.contains(event.target)) closeProjectMenu(); });
  document.addEventListener("contextmenu", event => { if (!event.target.closest("#project-list")) closeProjectMenu(); });
  window.addEventListener("resize", () => closeProjectMenu());
  document.addEventListener("scroll", () => closeProjectMenu(), true);
  menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget)) closeProjectMenu(); });
  menu.addEventListener("keydown", event => {
    const buttons = [...menu.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeProjectMenu(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    } else if (event.key === "Tab") closeProjectMenu();
  });
  menu.addEventListener("click", event => {
    const command = event.target.closest("[data-project-command]")?.dataset.projectCommand;
    if (!command) return;
    // Return focus to the project first, so the dialog restores it when it closes.
    closeProjectMenu(true);
    if (command === "settings") openSettings(contextProject);
    else if (command === "rules") { selectProject(contextProject); selectTab("rules"); }
    else openDeleteProject(contextProject);
  });

  function readSettings() {
    const values = {};
    for (const [field, key] of settingsFields) values[key] = $("settings-" + field).value.trim();
    values.plannedMembers = [...new Set($("settings-members").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    return values;
  }
  const settingsDirty = () => !!settingsProject && JSON.stringify(readSettings()) !== settingsBaseline;
  function fillSettings(project) {
    settingsProject = structuredClone(project);
    for (const [field, key] of settingsFields) $("settings-" + field).value = project[key] || "";
    $("settings-members").value = list(project.plannedMembers).join("\n");
    settingsBaseline = JSON.stringify(readSettings());
    setText("settings-context", project.root, true);
    $("settings-reload").hidden = true;
    clearValidation($("settings-form"));
    updateSettingsState();
  }
  function updateSettingsState() {
    const members = readSettings().plannedMembers.length, sessions = settingsProject ? activeCount(settingsProject.id) : 0;
    setText("settings-members-count", members ? message("{n} 项", {n: members}) : "可选");
    setText("settings-root-active", sessions ? message("当前有 {n} 个活动会话，保存时无法更换路径。", {n: sessions}) : "");
    $("settings-root-active").hidden = !sessions;
    $("settings-save").disabled = settingsPending || !state.token || !settingsDirty();
    $("settings-delete").disabled = settingsPending || !state.token || !settingsProject;
    $("settings-reload").disabled = settingsPending;
  }
  function openSettings(id) {
    const project = state.projects.find(item => item.id === id);
    if (!project || !state.token) return;
    fillSettings(project);
    feedback("settings-feedback", "");
    $("settings-dialog").showModal();
    $("settings-name").focus();
  }
  function closeSettings(force = false) {
    if (settingsPending) return false;
    if (!force && settingsDirty() && !confirm(t("放弃未保存的设置修改？"))) return false;
    $("settings-dialog").close();
    return true;
  }
  $("settings-dialog").addEventListener("cancel", event => {
    if (settingsPending || (settingsDirty() && !confirm(t("放弃未保存的设置修改？")))) event.preventDefault();
  });
  $("settings-dialog").addEventListener("close", () => { settingsProject = null; settingsBaseline = ""; });
  $("settings-form").addEventListener("input", updateSettingsState);
  $("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (settingsPending || !settingsProject || !state.token || !validate(event.currentTarget)) return;
    if (!settingsDirty()) { closeSettings(true); return; }
    const values = readSettings(), target = settingsProject;
    if (values.plannedMembers.length > 100 || values.plannedMembers.some(member => member.length > 200)) {
      feedback("settings-feedback", "最多 100 位拟共享人员，每项不超过 200 个字符。", "error");
      return;
    }
    settingsPending = true;
    $("settings-reload").hidden = true;
    setPending("settings-form", "settings-fields", "settings-save", true, "保存中…", "settings-feedback");
    updateSettingsState();
    try {
      const {project} = await api("/api/projects/" + encodeURIComponent(target.id), {method: "PATCH", body: {baseRevision: target.settingsRevision || 0, ...values}});
      if (!project?.id) throw new ApiError("服务器返回了无效的数据。", 0);
      state.projects = state.projects.map(item => item.id === project.id ? project : item);
      if (project.root !== target.root) state.policyFeedback.set(project.id, {text: "路径已更改，请为新目录重新写入接入规则。", type: ""});
      settingsPending = false;
      closeSettings(true);
      announce("设置已保存。");
      requestSync();
    } catch (error) {
      const conflict = error.status === 409 && (error.code === "settings_conflict" || error.source === revisionConflict);
      feedback("settings-feedback", conflict ? "设置已被其他操作更新，草稿已保留。可载入最新设置后重新修改。" : cleanError(error), "error");
      $("settings-reload").hidden = !conflict;
    } finally {
      settingsPending = false;
      setPending("settings-form", "settings-fields", "settings-save", false, "保存设置", "settings-feedback");
      updateSettingsState();
      render();
    }
  });
  $("settings-reload").addEventListener("click", async () => {
    if (settingsPending || !settingsProject) return;
    if (settingsDirty() && !confirm(t("放弃当前草稿并载入最新设置？"))) return;
    const id = settingsProject.id;
    try {
      const latest = await latestProject(id);
      if (!latest) { feedback("settings-feedback", "项目已不存在或已删除。", "error"); return; }
      fillSettings(latest);
      feedback("settings-feedback", "已载入最新设置。", "success");
      $("settings-name").focus();
    } catch (error) { feedback("settings-feedback", cleanError(error), "error"); }
  });
  $("settings-delete").addEventListener("click", () => { if (!settingsPending && settingsProject) openDeleteProject(settingsProject.id); });

  function fillDelete(project) {
    deleteTarget = structuredClone(project);
    setText("delete-project-name", project.name, true);
    setText("delete-project-root", project.root, true);
    const sessions = activeCount(project.id);
    setText("delete-project-active", sessions ? message("当前有 {n} 个活动会话，需全部结束后才能删除。", {n: sessions}) : "");
    $("delete-project-active").hidden = !sessions;
  }
  function openDeleteProject(id) {
    const project = state.projects.find(item => item.id === id);
    if (!project || !state.token) return;
    fillDelete(project);
    feedback("delete-project-feedback", "");
    $("delete-project-dialog").showModal();
    $("delete-project-cancel").focus();
  }
  function setDeletePending(pending) {
    deletePending = pending;
    $("delete-project-form").setAttribute("aria-busy", String(pending));
    $("delete-project-confirm").disabled = pending;
    for (const button of $("delete-project-form").querySelectorAll('[data-action^="close-"]')) button.disabled = pending;
    const span = $("delete-project-confirm").querySelector("span");
    uiSources.set(span, pending ? "删除中…" : "确认删除");
    span.textContent = t(pending ? "删除中…" : "确认删除");
    if (pending) feedback("delete-project-feedback", "正在提交…");
  }
  $("delete-project-dialog").addEventListener("cancel", event => { if (deletePending) event.preventDefault(); });
  $("delete-project-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (deletePending || !deleteTarget || !state.token) return;
    const target = deleteTarget;
    setDeletePending(true);
    try {
      await api("/api/projects/" + encodeURIComponent(target.id) + "/delete", {method: "POST", body: {baseRevision: target.settingsRevision || 0}});
      state.projects = state.projects.filter(project => project.id !== target.id);
      setDeletePending(false);
      $("delete-project-dialog").close();
      if ($("settings-dialog").open) closeSettings(true);
      if (state.selectedId === target.id) selectProject(state.projects[0]?.id || "", false);
      for (const store of [state.snapshots, state.messageDrafts, state.noteDrafts, state.policyFeedback]) store.delete(target.id);
      for (const scope of Object.keys(ruleScopes)) rules.drafts.delete(ruleKey(scope, target.id));
      announce("项目已删除。");
      render();
      requestSync();
    } catch (error) {
      // Show what changed before a second confirmation; the server still checks the new revision.
      if (error.status === 409 && (error.code === "settings_conflict" || error.source === revisionConflict)) {
        try { const latest = await latestProject(target.id); if (latest) fillDelete(latest); } catch {}
      }
      feedback("delete-project-feedback", cleanError(error), "error");
    } finally {
      if (deletePending) setDeletePending(false);
    }
  });

  // Project rules: read-only platform text, editable project/local text, read confirmation and owner grants.
  // Drafts are kept per project and scope; polling never overwrites a changed draft.
  const ruleScopes = {project: "项目规则", local: "本地规则"};
  const rules = {project: "", data: null, inflight: new Map(), loadedAt: 0, error: "", pending: "", drafts: new Map(), agentKey: ""};
  const ruleKey = (scope, id = rules.project) => `${id}:${scope}`;
  const shortRevision = value => typeof value === "string" ? value.slice(0, 10) : String(value ?? "");
  function setLabel(button, key) {
    const span = button.querySelector("span");
    uiSources.set(span, key);
    span.textContent = t(key);
  }
  function acceptRules(data) {
    if (!data?.platform || !data.project || !data.local || !data.permissions) throw new ApiError("服务器返回了无效的数据。", 0);
    rules.data = data;
    rules.error = "";
    for (const scope of Object.keys(ruleScopes)) {
      const draft = rules.drafts.get(ruleKey(scope));
      if (draft?.dirty) draft.conflict = draft.base !== data[scope].revision;
      else rules.drafts.set(ruleKey(scope), {text: data[scope].text, base: data[scope].revision, baseText: data[scope].text, dirty: false, conflict: false});
    }
  }
  // One request per project (A→B→A reuses the first A request); an entry is removed only by its own promise.
  function loadRules() {
    const id = rules.project;
    if (!id || !state.token) return Promise.resolve();
    if (rules.inflight.has(id)) return rules.inflight.get(id);
    const promise = (async () => {
      try {
        const result = await api(`/api/projects/${encodeURIComponent(id)}/rules`);
        if (rules.project === id) acceptRules(result.rules);
      } catch (error) {
        if (rules.project === id) rules.error = cleanError(error);
      } finally {
        if (rules.inflight.get(id) === promise) rules.inflight.delete(id);
        if (rules.project === id) rules.loadedAt = Date.now();
        paintRules();
      }
    })();
    rules.inflight.set(id, promise);
    paintRules();
    return promise;
  }
  function renderRules() {
    if (rules.project !== state.selectedId) {
      rules.project = state.selectedId;
      rules.data = null;
      rules.loadedAt = 0;
      rules.error = "";
      feedback("rules-feedback", "");
    }
    if (state.tab === "rules" && rules.project && state.token && !rules.inflight.has(rules.project) && Date.now() - rules.loadedAt > 15000) void loadRules();
    paintRules();
  }
  function confirmationState(data) {
    const current = {platform: data.platform.revision, project: data.project.revision, local: data.local.revision};
    const confirmation = data.confirmation;
    if (!confirmation) return {current, type: "pending", badge: "未确认", text: "尚未确认当前规则。"};
    const changed = Object.keys(current).filter(scope => confirmation.revisions?.[scope] !== current[scope]);
    if (!changed.length) return {current, type: "confirmed", badge: "已确认", text: message("已于 {time} 确认当前规则。", {time: date(confirmation.confirmedAt)})};
    const names = changed.map(scope => t(scope === "platform" ? "平台规则" : ruleScopes[scope])).join(language === "en" ? ", " : "、");
    return {current, type: "pending", badge: "已变更", text: message("确认后规则已变更（{scopes}），请重新阅读并确认。", {scopes: names})};
  }
  function paintRules() {
    const data = rules.data, busy = !!rules.pending;
    $("rules-content").hidden = !data;
    $("rules-reload").disabled = !state.token || !rules.project || busy || rules.inflight.has(rules.project);
    const dirty = Object.keys(ruleScopes).some(scope => rules.drafts.get(ruleKey(scope))?.dirty);
    if (!data) {
      $("rules-status-badge").className = "badge";
      setText("rules-status-badge", rules.error ? "规则暂不可用" : "未确认");
      setText("rules-status-text", rules.error || "正在载入规则…");
      $("rules-confirm").disabled = true;
      return;
    }
    const status = confirmationState(data);
    $("rules-status-badge").className = `badge ${status.type}`;
    setText("rules-status-badge", status.badge);
    setText("rules-status-text", status.text);
    $("rules-confirm").disabled = busy || dirty || status.type === "confirmed";
    $("rules-confirm").title = dirty ? t("有未保存的修改，请先保存或放弃后再确认。") : "";
    setLabel($("rules-confirm"), rules.pending === "confirm" ? "确认中…" : "确认当前规则");

    setText("rules-platform-source", data.platform.source, true);
    setText("rules-platform-revision", message("版本 {v}", {v: shortRevision(data.platform.revision)}));
    if ($("rules-platform-text").textContent !== data.platform.text) $("rules-platform-text").textContent = data.platform.text;

    for (const scope of Object.keys(ruleScopes)) {
      const draft = rules.drafts.get(ruleKey(scope)), editable = scope === "project" ? data.permissions.editProject : data.permissions.editLocal;
      const editor = $(`rules-${scope}-text`), access = $(`rules-${scope}-access`), stateLine = $(`rules-${scope}-state`);
      if (editor.value !== draft.text) editor.value = draft.text;
      editor.readOnly = !editable || busy;
      access.className = `badge${editable ? " editable" : ""}`;
      setText(access.id, editable ? "可编辑" : "只读");
      stateLine.className = `rules-state${draft.conflict ? " conflict" : draft.dirty ? " dirty" : ""}`;
      setText(stateLine.id, draft.conflict ? "服务器上已有新版本，草稿已保留。可载入最新版本后重新修改。" : draft.dirty ? "有未保存的修改。" : editable ? "" : "只读：需要管理员或获授权的工作中 Agent。");
      $(`rules-${scope}-discard`).hidden = !draft.dirty || draft.conflict;
      $(`rules-${scope}-latest`).hidden = !draft.conflict;
      for (const id of [`rules-${scope}-discard`, `rules-${scope}-latest`]) $(id).disabled = busy;
      $(`rules-${scope}-save`).disabled = busy || !editable || !draft.dirty;
      setLabel($(`rules-${scope}-save`), rules.pending === scope ? "保存中…" : scope === "project" ? "保存项目规则" : "保存本地规则");
    }
    setText("rules-project-revision", message("版本 {v}", {v: data.project.revision}));
    setText("rules-project-updated", data.project.updatedAt ? message("更新于 {time} · {who}", {time: date(data.project.updatedAt), who: data.project.updatedBy || ""}) : "尚未保存过");
    setText("rules-local-source", data.local.source, true);
    setText("rules-local-revision", message("版本 {v}", {v: shortRevision(data.local.revision)}));
    if ($("rules-local-managed").textContent !== data.local.managedText) $("rules-local-managed").textContent = data.local.managedText || "";
    $("rules-local-managed").closest("details").hidden = !data.local.managedText;
    paintGrants(data, busy);
  }
  function paintGrants(data, busy) {
    $("rules-grants").hidden = !data.permissions.manageGrants;
    if (!data.permissions.manageGrants) return;
    const select = $("rules-grant-agent"), agents = [...new Set(list(snapshot()?.agents).filter(agent => agent.status === "working").map(agent => agent.agentId))].sort();
    const key = agents.join("|") + language;
    if (rules.agentKey !== key) {
      const previous = select.value;
      select.replaceChildren(...(agents.length ? agents.map(agentId => new Option(agentId, agentId)) : [new Option(t("当前没有工作中的 Agent"), "")]));
      if (agents.includes(previous)) select.value = previous;
      rules.agentKey = key;
    }
    $("rules-grant-fields").disabled = busy;
    $("rules-grant-submit").disabled = busy || !agents.length;
    setLabel($("rules-grant-submit"), rules.pending === "grant" ? "授权中…" : "授予授权");
    const now = Date.now(), current = snapshot(), sessions = new Map(list(current?.agents).map(agent => [agent.id, agent.status]));
    const grants = [...list(data.grants)].sort((a, b) => (stamp(b.expiresAt) ?? 0) - (stamp(a.expiresAt) ?? 0));
    reconcile($("rules-grant-list"), grants, () => element("li", "rules-grant"), (node, grant) => {
      // The server only honours grants for a session that is still working.
      const status = grant.revokedAt ? "已撤销" : (stamp(grant.expiresAt) ?? 0) <= now ? "已过期" : current && sessions.get(grant.sessionId) !== "working" ? "会话已结束" : "有效";
      node.className = `rules-grant${status === "有效" ? "" : " inactive"}`;
      const scopes = list(grant.scopes).map(scope => `<span class="badge">${escape(t(ruleScopes[scope] || scope))}</span>`).join("");
      markup(node, `<div class="rules-grant-head"><strong>${escape(grant.agentId)}</strong>${scopes}<span class="badge${status === "有效" ? " active" : ""}">${escape(t(status))}</span></div>${status === "有效" ? `<button type="button" class="secondary-button compact" data-rules-revoke="${escape(grant.id)}" data-agent="${escape(grant.agentId)}"${busy ? " disabled" : ""}><span>${escape(t("撤销"))}</span></button>` : "<span></span>"}<p>${escape(grant.reason)}</p><time>${escape(t("{time} 到期", {time: date(grant.expiresAt)}))}</time>`);
    });
    $("rules-grant-empty").hidden = grants.length > 0;
  }
  // Disabled or hidden buttons drop focus to <body>; move it to the control the user will need next.
  function keepRulesFocus(kind) {
    if (document.activeElement && document.activeElement !== document.body) return;
    $(Object.hasOwn(ruleScopes, kind) ? `rules-${kind}-text` : kind === "confirm" ? "rules-reload" : "rules-grant-reason")?.focus();
  }
  async function rulesRequest(kind, path, body, success) {
    const id = rules.project;
    if (!id || !state.token || rules.pending) return false;
    const target = ["grant", "revoke"].includes(kind) ? "rules-grant-feedback" : "rules-feedback";
    rules.pending = kind;
    feedback(target, "正在提交…");
    paintRules();
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/rules${path}`, {method: path ? "POST" : "PATCH", body});
      // The save succeeded for the original project even if the owner has switched away since.
      if (Object.hasOwn(ruleScopes, kind)) rules.drafts.delete(ruleKey(kind, id));
      if (rules.project !== id) return true;
      acceptRules(result.rules);
      feedback(target, success, "success");
      announce(success);
      requestSync();
      return true;
    } catch (error) {
      if (rules.project !== id) return false;
      const draft = rules.drafts.get(ruleKey(kind, id));
      if (error.status === 409 && error.code === "rules_conflict") {
        if (draft) draft.conflict = true;
        rules.loadedAt = 0;
      }
      feedback(target, cleanError(error), "error");
      return false;
    } finally {
      rules.pending = "";
      paintRules();
      if (rules.project === id) keepRulesFocus(kind);
      if (rules.loadedAt === 0 && rules.project === id) void loadRules();
    }
  }
  function discardRuleDraft(scope, ask = true) {
    const draft = rules.drafts.get(ruleKey(scope)), data = rules.data?.[scope];
    if (!draft || !data) return;
    if (ask && draft.dirty && !confirm(t("放弃对{scope}的未保存修改？", {scope: t(ruleScopes[scope])}))) return;
    rules.drafts.set(ruleKey(scope), {text: data.text, base: data.revision, baseText: data.text, dirty: false, conflict: false});
    paintRules();
    keepRulesFocus(scope);
  }
  for (const scope of Object.keys(ruleScopes)) {
    $(`rules-${scope}-text`).addEventListener("input", event => {
      const draft = rules.drafts.get(ruleKey(scope));
      if (!draft || event.target.readOnly) return;
      draft.text = event.target.value;
      draft.dirty = draft.text !== draft.baseText;
      if (!draft.dirty) draft.conflict = false;
      paintRules();
    });
    $(`rules-${scope}-save`).addEventListener("click", () => {
      const draft = rules.drafts.get(ruleKey(scope));
      if (draft?.dirty) void rulesRequest(scope, "", {scope, baseRevision: draft.base, text: draft.text}, "规则已保存。");
    });
    $(`rules-${scope}-discard`).addEventListener("click", () => discardRuleDraft(scope));
    $(`rules-${scope}-latest`).addEventListener("click", async () => {
      if (!confirm(t("放弃对{scope}的未保存修改？", {scope: t(ruleScopes[scope])}))) return;
      const id = rules.project;
      rules.loadedAt = 0;
      await loadRules();
      // The owner may have switched projects while the reload was in flight.
      if (rules.project !== id) return;
      discardRuleDraft(scope, false);
      $(`rules-${scope}-text`).focus();
    });
  }
  $("rules-reload").addEventListener("click", () => { rules.loadedAt = 0; feedback("rules-feedback", ""); void loadRules(); });
  $("rules-confirm").addEventListener("click", () => {
    if (rules.data) void rulesRequest("confirm", "/confirm", {revisions: confirmationState(rules.data).current}, "已确认当前规则。");
  });
  $("rules-grant-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (rules.pending || !validate(form)) return;
    const scopes = [...form.querySelectorAll('input[name="scope"]:checked')].map(input => input.value);
    if (!scopes.length) { feedback("rules-grant-feedback", "请至少选择一个授权范围。", "error"); return; }
    const body = {agentId: $("rules-grant-agent").value, scopes, reason: $("rules-grant-reason").value.trim(), expiresInMinutes: Number($("rules-grant-minutes").value)};
    if (await rulesRequest("grant", "/grants", body, "授权已授予。")) {
      $("rules-grant-reason").value = "";
      for (const input of form.querySelectorAll('input[name="scope"]')) input.checked = false;
    }
  });
  $("rules-grant-list").addEventListener("click", event => {
    const button = event.target.closest("[data-rules-revoke]");
    if (!button || button.disabled) return;
    if (!confirm(t("撤销 {agent} 的规则修改授权？", {agent: button.dataset.agent}))) return;
    void rulesRequest("revoke", "/grants", {grantId: button.dataset.rulesRevoke, revoke: true}, "授权已撤销。");
  });

  function openNote() {
    if (!state.selectedId || !snapshot()) return;
    state.noteProjectId = state.selectedId;
    const draft = state.noteDrafts.get(state.noteProjectId);
    $("note-title").value = draft?.title || "";
    $("note-text").value = draft?.text || "";
    $("note-tags").value = draft?.tags || "";
    clearValidation($("note-form"));
    feedback("note-feedback", "");
    setText("note-project-name", selectedProject()?.name || "", true);
    $("note-dialog").showModal();
  }
  function openCancel(sessionId) {
    const agent = list(snapshot()?.agents).find(item => item.id === sessionId);
    if (!agent || !active(agent)) return;
    state.cancelAgent = {id: agent.id, agentId: agent.agentId, projectId: state.selectedId};
    $("cancel-form").reset();
    setText("cancel-target", `${agent.agentId} · ${agent.id}`, true);
    feedback("cancel-feedback", "");
    $("cancel-dialog").showModal();
  }

  $("project-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.projectPending || !state.token || !validate(event.currentTarget)) return;
    const body = {name: $("new-project-name").value.trim(), root: $("new-project-root").value.trim(), leaseMs: Number($("new-project-lease").value) * 1000, idleMs: Number($("new-project-idle").value) * 60000, installPolicy: $("new-project-policy").checked};
    const description = $("new-project-description").value.trim();
    if (description) body.description = description;
    state.projectPending = true;
    setPending("project-form", "project-fields", "create-project-button", true, "创建中…", "project-feedback");
    try {
      const {project, policy} = await api("/api/projects", {method: "POST", body});
      if (!project?.id) throw new ApiError("项目已提交，但返回数据无效。请先刷新确认，避免重复创建。", 0);
      if (!state.projects.some(item => item.id === project.id)) state.projects.push(project);
      if (policy) storePolicyResult(project.id, policy, true);
      state.projectsLoaded = true;
      selectProject(project.id, false);
      $("project-dialog").close();
      $("project-form").reset();
      announce("项目已创建。");
      requestSync();
    } catch (error) { feedback("project-feedback", cleanError(error), "error"); }
    finally {
      state.projectPending = false;
      setPending("project-form", "project-fields", "create-project-button", false, "创建项目", "project-feedback");
      renderConnection();
    }
  });
  $("message-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.messagePending || !state.token || !snapshot() || !validate(event.currentTarget)) return;
    const projectId = state.selectedId;
    const body = {projectId, toAgentId: $("message-recipient").value.trim(), text: $("message-text").value.trim(), kind: event.currentTarget.elements.kind.value};
    saveMessageDraft();
    state.messagePending = true;
    setPending("message-form", "message-fields", "send-button", true, "发送中…", "message-feedback");
    try {
      const {message} = await api("/api/messages", {method: "POST", body});
      if (message?.id) appendSnapshot(projectId, "messages", message);
      const draft = state.messageDrafts.get(projectId);
      if (draft) { draft.text = ""; draft.feedback = "消息已提交。"; draft.feedbackClass = "form-feedback success"; }
      if (state.selectedId === projectId) { $("message-text").value = ""; feedback("message-feedback", "消息已提交。", "success"); }
      announce("消息已提交。");
      requestSync();
    } catch (error) {
      const draft = state.messageDrafts.get(projectId);
      if (draft) { draft.feedback = cleanError(error); draft.feedbackClass = "form-feedback error"; }
      if (state.selectedId === projectId) feedback("message-feedback", cleanError(error), "error");
    } finally {
      state.messagePending = false;
      setPending("message-form", "message-fields", "send-button", false, "发送", "message-feedback");
      render();
    }
  });
  $("note-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.notePending || !state.token || !state.noteProjectId || !validate(event.currentTarget)) return;
    const tags = [...new Set($("note-tags").value.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean))];
    if (tags.length > 12 || tags.some(tag => tag.length > 40)) { feedback("note-feedback", "最多 12 个标签，每个标签不超过 40 个字符。", "error"); return; }
    const projectId = state.noteProjectId;
    const body = {title: $("note-title").value.trim(), text: $("note-text").value.trim(), tags};
    state.notePending = true;
    setPending("note-form", "note-fields", "publish-note-button", true, "发布中…", "note-feedback");
    try {
      const {note} = await api(`/api/projects/${encodeURIComponent(projectId)}/notes`, {method: "POST", body});
      if (note?.id) appendSnapshot(projectId, "notes", note);
      state.noteDrafts.delete(projectId);
      $("note-form").reset();
      $("note-dialog").close();
      if (state.selectedId === projectId) selectTab("board");
      announce("公告已发布。");
      requestSync();
    } catch (error) { feedback("note-feedback", cleanError(error), "error"); }
    finally {
      state.notePending = false;
      setPending("note-form", "note-fields", "publish-note-button", false, "发布", "note-feedback");
      render();
    }
  });
  $("cancel-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.cancelPending || !state.token || !state.cancelAgent) return;
    const target = {...state.cancelAgent};
    const body = {reason: "cancelled"}, summary = $("cancel-summary").value.trim();
    if (summary) body.summary = summary;
    state.cancelPending = true;
    setPending("cancel-form", "cancel-fields", "confirm-cancel-button", true, "终止中…", "cancel-feedback");
    try {
      const {session} = await api(`/api/sessions/${encodeURIComponent(target.id)}/leave`, {method: "POST", body});
      if (session?.id) appendSnapshot(target.projectId, "agents", session);
      $("cancel-dialog").close();
      announce(message("{agent} 的会话已取消。", {agent: target.agentId}));
      requestSync();
    } catch (error) { feedback("cancel-feedback", cleanError(error), "error"); }
    finally {
      state.cancelPending = false;
      setPending("cancel-form", "cancel-fields", "confirm-cancel-button", false, "确认终止", "cancel-feedback");
      render();
    }
  });
  function appendSnapshot(projectId, field, item) {
    const data = state.snapshots.get(projectId);
    if (!data) return;
    const index = data[field].findIndex(entry => entry.id === item.id);
    if (index < 0) data[field].push(item);
    else data[field][index] = item;
  }
  function storePolicyResult(projectId, policy, created = false) {
    state.policyFeedback.set(projectId, {policy, created, type: policy.installed ? "success" : "error"});
  }
  function policyResultText(policy, created) {
    const prefix = created ? t("项目已创建。") + " " : "";
    return prefix + (policy.installed ? t("接入规则已写入{files}", {files: list(policy.files).length ? ": " + policy.files.join(language === "en" ? ", " : "、") : "."}) : t("接入规则写入失败：{error}", {error: t(cleanError(new Error(policy.error || "未返回安装结果。")))}));
  }
  async function installPolicy() {
    const projectId = state.selectedId;
    if (!state.token || !projectId || state.policyPending.has(projectId)) return;
    state.policyPending.add(projectId);
    state.policyFeedback.set(projectId, {text: "正在写入接入规则…", type: ""});
    renderHeading();
    renderConnection();
    try {
      const policy = await api(`/api/projects/${encodeURIComponent(projectId)}/policy`, {method: "POST", body: {}});
      storePolicyResult(projectId, policy);
      requestSync();
    } catch (error) { state.policyFeedback.set(projectId, {text: cleanError(error), type: "error"}); }
    finally {
      state.policyPending.delete(projectId);
      renderHeading();
      renderConnection();
    }
  }

  document.addEventListener("click", event => {
    const project = event.target.closest("[data-project-id]");
    if (project) { selectProject(project.dataset.projectId); return; }
    const tab = event.target.closest("[data-tab]");
    if (tab) { selectTab(tab.dataset.tab); return; }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.action) {
      case "refresh": requestSync(); break;
      case "install-policy": void installPolicy(); break;
      case "edit-project": openSettings(state.selectedId); break;
      case "close-settings": closeSettings(); break;
      case "close-delete-project": closeDialog("delete-project-dialog", deletePending); break;
      case "open-project": openProject(); break;
      case "close-project": closeDialog("project-dialog", state.projectPending); break;
      case "open-note": openNote(); break;
      case "close-note": saveNoteDraft(); closeDialog("note-dialog", state.notePending); break;
      case "cancel-session": openCancel(button.dataset.sessionId); break;
      case "close-cancel": closeDialog("cancel-dialog", state.cancelPending); break;
      case "select-session": state.selectedSession = state.selectedSession === button.dataset.sessionId ? "" : button.dataset.sessionId; renderAgents(); renderConnection(); break;
      case "close-detail": {
        const sessionId = state.selectedSession;
        state.selectedSession = "";
        renderAgents();
        const owner = [...$("agent-rows").querySelectorAll(".agent-name")].find(node => node.dataset.sessionId === sessionId);
        owner?.focus();
        break;
      }
    }
  });
  document.querySelector(".tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const index = tabs.findIndex(tab => tab.dataset.tab === state.tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    selectTab(tabs[next].dataset.tab, true);
  });
  for (const [id, pending] of [["project-dialog", () => state.projectPending], ["note-dialog", () => state.notePending], ["cancel-dialog", () => state.cancelPending]]) {
    $(id).addEventListener("cancel", event => {
      if (pending()) event.preventDefault();
      else if (id === "note-dialog") saveNoteDraft();
    });
  }
  const searches = {"project-search": renderProjects, "agent-search": renderAgents, "note-search": renderNotes, "message-search": renderMessages, "event-search": renderEvents};
  for (const [id, renderSearch] of Object.entries(searches)) $(id).addEventListener("input", () => { renderSearch(); renderConnection(); });
  $("show-history").addEventListener("change", () => { renderAgents(); renderConnection(); });
  $("message-filter").addEventListener("change", renderMessages);
  document.addEventListener("input", event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) event.target.setCustomValidity("");
  });
  $("message-form").addEventListener("input", saveMessageDraft);
  $("note-form").addEventListener("input", saveNoteDraft);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) requestSync(); });
  window.addEventListener("pagehide", () => clearTimeout(state.timer));
  window.addEventListener("pageshow", event => { if (event.persisted) requestSync(); });
  $("theme-select").addEventListener("change", event => window.AgentCoordinatorTheme?.setMode(event.target.value));
  window.addEventListener("agent-coordinator-themechange", renderThemeControl);
  function changeLanguage(value, persist = true) {
    language = validLanguage(value);
    if (persist) try { localStorage.setItem(languageKey, language); } catch {}
    updateFormats();applyLanguage();renderThemeControl();render();
  }
  $("language-select").addEventListener("change", event => changeLanguage(event.target.value));
  window.addEventListener("storage", event => {
    if (event.key === languageKey || event.key === null) changeLanguage(event.newValue, false);
  });

  $("message-text").maxLength = 8000;
  $("message-recipient").maxLength = 120;
  $("message-recipient").pattern = "(?:\\*|[\\w.:\\-]+)";
  $("cancel-summary").maxLength = 8000;
  window.lucide?.createIcons();
  applyLanguage();
  const roadmapUI=window.AgentRoadmap?.create(api);
  renderThemeControl();
  render();
  void sync();
})();
