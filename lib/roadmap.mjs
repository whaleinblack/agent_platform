export const roadmapLimit = 64 * 1024;
export const emptyRoadmap = projectId => ({projectId, revision: 0, editorAgentId: null, html: '', updatedAt: null, updatedBy: null, history: []});
export const roadmapMeta = value => {const {html,history,...meta}=value;return {...meta,hasContent:!!html};};
export const roadmapPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

// A render-only stylesheet: persisted HTML and revision history are never rewritten.
// Values are selected from fixed palettes, never interpolated from request text.
export function renderRoadmap(html, requestedTheme) {
  const theme = requestedTheme === 'dark' ? 'dark' : 'light';
  const palette = theme === 'dark'
    ? ['#0c0e12','#121519','#e9ecf1','#8e98a7','#2b313b','#5eaaff','#7debc1','#ffc46b','#ef98a1','#5eaaff']
    : ['#f3f6fa','#ebf0f6','#17202b','#586476','#d2dbe6','#1b62c4','#0a7655','#855400','#b02f3d','#1b62c4'];
  const names = ['bg','surface','text','muted','border','link','success','warning','danger','info'];
  const variables = names.map((name,i)=>`--roadmap-${name}:${palette[i]} !important`).join(';');
  return (html || '<!doctype html><meta charset="utf-8"><title>Roadmap</title>') + `
<style data-roadmap-theme="${theme}">
:root{${variables};color-scheme:${theme} !important;background:var(--roadmap-bg) !important;color:var(--roadmap-text) !important}
body{background:var(--roadmap-bg) !important;color:var(--roadmap-text) !important}
:where(table){border-collapse:collapse;background:var(--roadmap-bg);color:var(--roadmap-text)}
:where(th){background:var(--roadmap-surface)}
:where(td,th){border:1px solid var(--roadmap-border)}
:where(a){color:var(--roadmap-link)}
:where(hr){border-color:var(--roadmap-border)}
:where(code,pre){background:var(--roadmap-surface);color:var(--roadmap-text)}
:where(small,.muted){color:var(--roadmap-muted)}
:where([data-status="success"]){color:var(--roadmap-success)}
:where([data-status="warning"]){color:var(--roadmap-warning)}
:where([data-status="danger"]){color:var(--roadmap-danger)}
:where([data-status="info"]){color:var(--roadmap-info)}
</style>`;
}
