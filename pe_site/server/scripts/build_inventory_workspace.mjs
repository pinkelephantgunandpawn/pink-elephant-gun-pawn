import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function generateInventoryWorkspaceTemplate(){
  const root=new URL('../../../tools/inventory-dashboard/',import.meta.url);
  const read=name=>readFileSync(new URL(name,root),'utf8');
  const nonce='PE_WORKSPACE_NONCE_PLACEHOLDER';
  const assets=Object.fromEntries(readdirSync(new URL('assets/',root)).filter(n=>/^[a-z-]+\.svg$/.test(n)).map(n=>['assets/'+n,'data:image/svg+xml;base64,'+Buffer.from(read('assets/'+n)).toString('base64')]));
  const parser=readFileSync(new URL('../offline_csv_preview.js',import.meta.url),'utf8');
  const code=[parser,read('model.mjs'),read('app.js')].map(s=>s.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'')).join('\n');
  const csp=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: https://images.unsplash.com https://images.pexels.com; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return read('index.html').replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/,`<meta http-equiv="Content-Security-Policy" content="${csp}">`).replace('<link rel="stylesheet" href="styles.css">',`<style nonce="${nonce}">${read('styles.css')}</style>`).replace('<script type="module" src="app.js"></script>',`<script nonce="${nonce}" type="module">const workspaceAssets=${JSON.stringify(assets)};\n${code.replace(/<\/script/gi,'<\\/script')}</script>`).replace('Production disconnected','Admin session · read-only tools').replace('Preview workspace','Inventory workspace').replace('Development preview','Existing administrator session');
}

if(process.argv[1]===fileURLToPath(import.meta.url))writeFileSync(new URL('../inventory_workspace_template.json',import.meta.url),JSON.stringify(generateInventoryWorkspaceTemplate())+'\n');
