// Self-contained logs page (served by the backend). No data is embedded; it asks /logs/data with the temporary key.
export const LOG_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Server logs</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0f1115;color:#e6e8ee;font:14px system-ui,sans-serif}header{padding:14px 16px;border-bottom:1px solid #222733;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0;flex:1}input,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid #2b3242;background:#171b24;color:#e6e8ee}button{cursor:pointer}button.on{background:#2f6df6;border-color:#2f6df6}
#gate{max-width:360px;margin:18vh auto;padding:0 16px;text-align:center}#gate input{width:100%;box-sizing:border-box;margin:12px 0;text-align:center;letter-spacing:2px}#err{color:#ff6b6b;min-height:20px}
#app{display:none}#bar{padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap}.wrap{overflow-x:auto;padding:0 16px 24px}table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #1d222d;vertical-align:top;word-break:break-word}th{color:#8b93a7;font-weight:600}
.tag{padding:2px 7px;border-radius:6px;background:#222a3a;font-size:12px}.bad{background:#4a1f26}.good{background:#1d3b2a}small{color:#8b93a7}</style></head><body>
<div id="gate"><h1>Server logs</h1><p><small>Enter the temporary key from the Telegram bot.</small></p><input id="k" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Key"><button id="go">Open logs</button><div id="err"></div></div>
<div id="app"><header><h1>Server logs</h1><small id="exp"></small></header>
<div id="bar"><button data-t="events" class="on">Events</button><button data-t="audit">Admin actions</button><button data-t="dreq">Domain requests</button><button data-t="blocked">Blocked IPs</button><input id="q" placeholder="Filter…" style="flex:1;min-width:120px"><button id="rf">Refresh</button></div>
<div class="wrap"><table><thead id="th"></thead><tbody id="tb"></tbody></table></div></div>
<script>
var KEY='',DATA=null,TAB='events',EXP=0;
function $(i){return document.getElementById(i)}
function fmt(t){return t?new Date(t).toLocaleString():''}
function load(){return fetch('/logs/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY})}).then(function(r){return r.json()})}
function open(){$('err').textContent='';KEY=$('k').value.trim();if(!KEY)return;load().then(function(j){if(!j.ok){$('err').textContent=(j.error&&j.error.message)||'Invalid key';return}DATA=j;EXP=j.exp;$('gate').style.display='none';$('app').style.display='block';render()}).catch(function(){$('err').textContent='Network error'})}
var COLS={events:['Time','Event','IP','User / email','Details'],audit:['Time','Action','By','Details'],dreq:['Time','Domain','IP'],blocked:['Until','IP','Reason']};
function rows(){var d=DATA;if(TAB==='events')return d.events.map(function(e){var x=[];['path','origin','amount','method','utr','matchId','left'].forEach(function(k){if(e[k]!==undefined&&e[k]!=='')x.push(k+': '+e[k])});return[fmt(e.at),e.event,e.ip||'',e.email||e.uid||'',x.join(' • ')]});
if(TAB==='audit')return d.audit.map(function(e){return[fmt(e.at),e.action,e.actor,JSON.stringify(e.data||{})]});
if(TAB==='dreq')return d.dreq.map(function(e){return[fmt(e.t),e.o,e.ip||'']});
return d.blocked.map(function(e){return[fmt(e.until),e.ip,e.reason||'']})}
function render(){var th=$('th'),tb=$('tb');th.textContent='';tb.textContent='';var tr=document.createElement('tr');COLS[TAB].forEach(function(c){var h=document.createElement('th');h.textContent=c;tr.appendChild(h)});th.appendChild(tr);
var q=$('q').value.toLowerCase();rows().forEach(function(r){if(q&&r.join(' ').toLowerCase().indexOf(q)<0)return;var t=document.createElement('tr');r.forEach(function(v,i){var td=document.createElement('td');if(TAB==='events'&&i===1){var s=document.createElement('span');s.className='tag'+(/fail|block|rate|denied/.test(v)?' bad':/login|deposit|withdraw|join|register/.test(v)?' good':'');s.textContent=v;td.appendChild(s)}else td.textContent=v;t.appendChild(td)});tb.appendChild(t)})}
document.querySelectorAll('[data-t]').forEach(function(b){b.onclick=function(){TAB=b.dataset.t;document.querySelectorAll('[data-t]').forEach(function(x){x.classList.toggle('on',x===b)});render()}});
$('go').onclick=open;$('k').onkeydown=function(e){if(e.key==='Enter')open()};$('q').oninput=render;
$('rf').onclick=function(){load().then(function(j){if(!j.ok){alert((j.error&&j.error.message)||'Key expired');location.reload();return}DATA=j;EXP=j.exp;render()})};
setInterval(function(){if(!EXP)return;var s=Math.round((EXP-Date.now())/1000);if(s<=0){$('exp').textContent='Key expired';document.body.textContent='This key has expired. Ask the bot for a new one.';EXP=0;KEY='';return}$('exp').textContent='Key expires in '+Math.floor(s/60)+'m '+(s%60)+'s'},1000);
</script></body></html>`;
