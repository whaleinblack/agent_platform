(() => {
  const words={preview:['预览','プレビュー','Preview'],code:['编辑 HTML','HTMLを編集','Edit HTML'],editor:['负责 Agent','担当 Agent','Responsible agent'],assign:['设置负责人','担当を設定','Assign'],save:['保存并发布','保存して公開','Save and publish'],reload:['重新载入','再読み込み','Reload'],empty:['暂无路线图','ロードマップは未登録です','No roadmap yet'],unassigned:['未指定，可由工作中的 Agent 认领','未指定。作業中の Agent が担当を取得できます','Unassigned; a working agent can claim it'],loading:['正在载入…','読み込み中…','Loading…'],saved:['已发布','公開しました','Published'],dirty:['有未保存的修改','未保存の変更があります','Unsaved changes'],changed:['路线图已有新版本，草稿未被覆盖。保存前请核对。','新しい版があります。下書きは保持されています。','A newer revision exists. Your draft was preserved; review before saving.'],discard:['放弃当前未保存的修改？','未保存の変更を破棄しますか？','Discard unsaved changes?'],history:['载入历史版本','履歴から読み込む','Load previous revision'],hint:['HTML/CSS · 上限 64 KiB · 脚本和外部资源不执行','HTML/CSS・最大64 KiB・スクリプトと外部リソースは無効','HTML/CSS · 64 KiB maximum · scripts and external resources disabled'],revision:['版本','版','Revision']};
  window.AgentRoadmap={create(api){
    const host=document.getElementById('panel-roadmap');
    host.innerHTML='<div class="roadmap-toolbar"><div class="roadmap-views"><button type="button" data-roadmap-view="preview" aria-pressed="true"></button><button type="button" data-roadmap-view="code" aria-pressed="false"></button></div><button type="button" id="roadmap-reload" class="secondary-button"></button></div><div class="roadmap-assignment"><label><span id="roadmap-editor-label"></span><input id="roadmap-editor" list="roadmap-agents" maxlength="120" autocomplete="off"></label><datalist id="roadmap-agents"></datalist><button type="button" id="roadmap-assign" class="secondary-button"></button></div><p id="roadmap-meta" class="roadmap-meta"></p><p id="roadmap-feedback" role="status" aria-live="polite"></p><div id="roadmap-preview"><p id="roadmap-empty" class="empty-state"></p><iframe id="roadmap-frame" title="Project roadmap" sandbox="" referrerpolicy="no-referrer" hidden></iframe></div><div id="roadmap-code" hidden><label id="roadmap-hint" for="roadmap-html"></label><textarea id="roadmap-html" spellcheck="false"></textarea><div class="roadmap-toolbar"><select id="roadmap-history"></select><button type="button" id="roadmap-save" class="primary-button"></button></div></div>';
    const $=id=>document.getElementById(id),drafts=new Map();let project='',lang='zh',token=false,view='preview',pending=false,stamp='',loading='',agentKey='';
    const t=k=>words[k]?.[{zh:0,ja:1,en:2}[lang]??0]||k;
    const current=()=>drafts.get(project),show=message=>{$('roadmap-feedback').textContent=message;};
    function views(){for(const b of host.querySelectorAll('[data-roadmap-view]'))b.setAttribute('aria-pressed',String(b.dataset.roadmapView===view));$('roadmap-preview').hidden=view!=='preview';$('roadmap-code').hidden=view!=='code';}
    function paint(){
      host.querySelector('[data-roadmap-view="preview"]').textContent=t('preview');host.querySelector('[data-roadmap-view="code"]').textContent=t('code');
      for(const [id,key]of [['roadmap-editor-label','editor'],['roadmap-assign','assign'],['roadmap-save','save'],['roadmap-reload','reload'],['roadmap-empty','empty'],['roadmap-hint','hint']])$(id).textContent=t(key);
      $('roadmap-editor').placeholder=t('unassigned');$('roadmap-history').setAttribute('aria-label',t('history'));$('roadmap-frame').title=t('preview');
      const d=current();$('roadmap-save').disabled=pending||!token||!d?.dirty;$('roadmap-assign').disabled=pending||!token||!d||!!d.dirty;$('roadmap-reload').disabled=pending||!token;
      $('roadmap-html').disabled=pending||!token||!d;$('roadmap-editor').disabled=pending||!token||!d;
      views();if(!d||!token)return;
      $('roadmap-meta').textContent=`${t('revision')} ${d.data.revision} · ${d.data.editorAgentId||t('unassigned')}${d.data.updatedAt?' · '+new Date(d.data.updatedAt).toLocaleString({zh:'zh-CN',ja:'ja-JP',en:'en-US'}[lang])+' · '+d.data.updatedBy:''}`;
      const key=project+':'+d.data.revision;
      $('roadmap-empty').hidden=!!d.data.html;$('roadmap-frame').hidden=!d.data.html;
      if(stamp!==key){$('roadmap-frame').src=d.data.html?`/api/projects/${encodeURIComponent(project)}/roadmap/render?v=${d.data.revision}`:'about:blank';stamp=key;}
      if($('roadmap-history').dataset.key!==key+lang){$('roadmap-history').replaceChildren(new Option(t('history'),''),...[...(d.data.history||[])].reverse().map(v=>new Option(`${t('revision')} ${v.revision} · ${v.updatedBy}`,String(v.revision))));$('roadmap-history').dataset.key=key+lang;}
    }
    function accept(id,data){
      const old=drafts.get(id),dirty=!!old?.dirty;drafts.set(id,{data,dirty,html:dirty?old.html:data.html,base:dirty?old.base:data.revision});
      if(id!==project)return;
      if(!dirty)$('roadmap-html').value=data.html;
      if(document.activeElement!==$('roadmap-editor'))$('roadmap-editor').value=data.editorAgentId||'';
      show(dirty&&old.base!==data.revision?t('changed'):dirty?t('dirty'):'');paint();
    }
    async function load(force=false){
      const id=project;if(!id||!token||loading===id)return;
      if(force&&current()?.dirty&&!confirm(t('discard')))return;
      if(force)drafts.delete(id);loading=id;show(t('loading'));paint();
      try{const result=await api(`/api/projects/${encodeURIComponent(id)}/roadmap`);accept(id,result.roadmap);}catch(e){if(id===project)show(e.status===404?({zh:'路线图后端待更新；其他功能仍可正常使用。',ja:'ロードマップのサーバー更新待ちです。他の機能は引き続き利用できます。',en:'Roadmap server update is pending. Other features remain available.'}[lang]):e.message);}finally{if(loading===id)loading='';}
    }
    async function save(assign=false){
      const id=project,d=current();if(!d||pending)return;pending=true;paint();
      try{const body=assign?{baseRevision:d.data.revision,editorAgentId:$('roadmap-editor').value.trim()||null}:{baseRevision:d.base,html:d.html};const result=await api(`/api/projects/${encodeURIComponent(id)}/roadmap`,{method:'PATCH',body});d.dirty=false;accept(id,result.roadmap);if(id===project)show(t('saved'));}
      catch(e){if(id===project)show(e.status===409?t('changed'):e.message);}finally{pending=false;paint();}
    }
    for(const b of host.querySelectorAll('[data-roadmap-view]'))b.onclick=()=>{view=b.dataset.roadmapView;views();};
    $('roadmap-html').oninput=()=>{const d=current();if(d){d.html=$('roadmap-html').value;d.dirty=true;show(t('dirty'));paint();}};
    $('roadmap-save').onclick=()=>void save();$('roadmap-assign').onclick=()=>void save(true);$('roadmap-reload').onclick=()=>void load(true);
    $('roadmap-history').onchange=()=>{const d=current(),old=d?.data.history.find(v=>String(v.revision)===$('roadmap-history').value);if(old){d.html=old.html;d.dirty=true;$('roadmap-html').value=d.html;view='code';show(t('dirty'));paint();}};
    return {render(id,snapshot,authorized,language,visible){
      lang=language;token=!!authorized;
      if(project!==id){project=id;loading='';stamp='';const d=current();$('roadmap-html').value=d?.html||'';$('roadmap-editor').value=d?.data.editorAgentId||'';$('roadmap-frame').src='about:blank';$('roadmap-frame').hidden=true;$('roadmap-empty').hidden=false;$('roadmap-meta').textContent='';show('');}
      if(!token){$('roadmap-frame').src='about:blank';stamp='';paint();return;}
      const names=[...new Set((snapshot?.agents||[]).map(a=>a.agentId))].sort();if(names.join('|')!==agentKey){agentKey=names.join('|');$('roadmap-agents').replaceChildren(...names.map(n=>new Option(n,n)));}
      paint();if(visible&&project&&(!current()||current().data.revision!==(snapshot?.roadmap?.revision??0)))void load();
    }};
  }};
})();
