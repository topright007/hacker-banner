/** All classifier and tool content is inserted with textContent, never as markup. */
export function approvalPage(nonce: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode — подтверждение операции</title>
<style nonce="${nonce}">
body{font:16px system-ui,sans-serif;max-width:880px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#20252c}h1{font-size:26px}article{background:white;border:1px solid #cdd3da;border-radius:10px;padding:22px;margin:20px 0}.warning{border:2px solid #b91c1c;background:#fff5f5}.warning-title{color:#991b1b;font-weight:700}h2{font-size:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f2f5;padding:14px;border-radius:6px;max-height:340px;overflow:auto}button{font:inherit;padding:10px 16px;margin:6px 10px 0 0;border-radius:6px;border:1px solid #adb5c0;cursor:pointer}button.reject{background:#a52424;color:white;border-color:#a52424}button:disabled{opacity:.5;cursor:wait}.note{color:#545e6b}.error{color:#a52424}p{overflow-wrap:anywhere}
</style></head><body>
<h1>Предупреждения безопасности OpenCode</h1>
<p class="note">Каждое решение относится только к указанной операции и не блокирует сессию. Штатные разрешения OpenCode продолжают действовать.</p>
<p id="status" role="status">Подключение…</p><main id="pending"></main>
<script nonce="${nonce}">
"use strict";
const capabilityKey="opencode.sensor.approval.capability";
const fragmentToken=location.hash.slice(1);let token=fragmentToken;
if(fragmentToken){
 try{
  sessionStorage.setItem(capabilityKey,fragmentToken);
  if(sessionStorage.getItem(capabilityKey)===fragmentToken)history.replaceState(null,"",location.pathname);
 }catch{/* Keep the fragment usable on reload when storage is disabled or full. */}
}else{
 try{token=sessionStorage.getItem(capabilityKey)||"";}catch{/* The full control URL can still restore access. */}
}
const status=document.getElementById("status"),container=document.getElementById("pending");
const cards=new Map();let polling=false;
function element(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
function setStatus(text,error=false){status.textContent=text;status.className=error?"error":"note";}
async function request(path,options={}){
 const response=await fetch(path,{...options,cache:"no-store",credentials:"omit",headers:{Authorization:"Bearer "+token,...options.headers}});
 if(!response.ok)throw new Error(response.status===401?"Ссылка подтверждения недействительна. Откройте URL из control.json заново.":"Ошибка панели (HTTP "+response.status+"). Обновите список и повторите действие.");
 return response.json();
}
function createCard(item){
 const card=element("article");card.className="warning";
 const warning=element("p","Предупреждение: классификатор отклонил эту операцию. Требуется ваше решение.");warning.className="warning-title";card.append(warning,element("h2",item.tool));
 card.append(element("p",item.phase==="pre_tool_call"?"До выполнения: инструмент ещё не запущен и ожидает вашего решения. «Продолжить» разрешит эту операцию. «Отменить действие» отменит только её.":"После выполнения: инструмент уже выполнился. Результат удерживается и пока не передан агенту. «Передать результат» разрешит его передачу, «Скрыть результат» — заменит его безопасной заглушкой. Уже выполненное действие не отменяется; повторного запуска не будет."));
 card.append(element("p","Причина предупреждения классификатора:"));card.append(element("pre",item.reason));
 card.append(element("p","Аргументы инструмента:"));card.append(element("pre",item.arguments));
 if(item.phase==="post_tool_call"){card.append(element("p","Предварительный просмотр результата:"));card.append(element("pre",item.result));}
 card.append(element("p","Длинные аргументы и результаты сокращаются с явной пометкой. Полный неизменный запрос, связанный с этим решением, доступен в JSON."));
 const download=element("button","Скачать полный запрос JSON");
 download.addEventListener("click",async()=>{download.disabled=true;try{
   const response=await fetch("/api/request/"+encodeURIComponent(item.id),{cache:"no-store",credentials:"omit",headers:{Authorization:"Bearer "+token}});
   if(!response.ok)throw new Error("Полный запрос недоступен (HTTP "+response.status+"). Возможно, решение уже принято.");
   const objectURL=URL.createObjectURL(await response.blob());const link=element("a");link.href=objectURL;link.download="request-"+item.id+".json";document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectURL),1000);
  }catch(error){setStatus(error.message,true);}finally{download.disabled=false;}});card.append(download);
 card.append(element("p","Сессия: "+item.session_id+" · Запрос: "+item.request_id));
 const allow=element("button",item.phase==="pre_tool_call"?"Продолжить":"Передать результат"),reject=element("button",item.phase==="pre_tool_call"?"Отменить действие":"Скрыть результат");reject.className="reject";
 const decide=async decision=>{allow.disabled=true;reject.disabled=true;try{
   await request("/api/decision",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:item.id,phase:item.phase,binding_digest:item.binding_digest,decision})});
   card.remove();cards.delete(item.id);await refresh();
  }catch(error){setStatus(error.message,true);allow.disabled=false;reject.disabled=false;}};
 allow.addEventListener("click",()=>void decide("allow"));reject.addEventListener("click",()=>void decide("reject"));card.append(allow,reject);return card;
}
async function refresh(){if(polling)return;polling=true;try{
 if(!token){setStatus("Откройте полный URL из control.json: в нём содержится ключ доступа к панели.",true);return;}
 const result=await request("/api/pending");const ids=new Set(result.pending.map(item=>item.id));
 for(const [id,card]of cards)if(!ids.has(id)){card.remove();cards.delete(id);}
 for(const item of result.pending)if(!cards.has(item.id)){const card=createCard(item);cards.set(item.id,card);container.append(card);}
 setStatus(result.pending.length?"Ожидают решения: "+result.pending.length:"Нет операций, ожидающих подтверждения.");
 }catch(error){setStatus(error.message,true);}finally{polling=false;}}
void refresh();setInterval(()=>void refresh(),2000);
</script></body></html>`;
}
