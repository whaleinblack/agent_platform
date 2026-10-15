export const roadmapLimit = 64 * 1024;
export const emptyRoadmap = projectId => ({projectId, revision: 0, editorAgentId: null, html: '', updatedAt: null, updatedBy: null, history: []});
export const roadmapMeta = value => {const {html,history,...meta}=value;return {...meta,hasContent:!!html};};
export const roadmapPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
