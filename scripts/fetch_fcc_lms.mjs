import { Unzip, UnzipInflate } from 'fflate';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const source = 'https://enterpriseefiling.fcc.gov/dataentry/api/download/dbfile/Current_LMS_Dump.zip';
const aliases = { applicationId: ['application id','application_id','aapp_application_id','afac_application_id'], facilityId: ['facility id','facility_id','afac_facility_id'], call: ['callsign','call sign','station','station callsign','call_sign','app_callsign','aapp_callsign'], city: ['city','community','station city','community of license','afac_community_city'], state: ['state','state code','state abbreviation','afac_community_state_code'], service: ['service','service code','facility type','service type','app service','service_code','afac_facility_type','afac_station_type'], file: ['file number','filenumber','file_num','aapp_file_num','application number','app number','file_no'], type: ['purpose','transaction type','application purpose','form','application type','purpose description','purpose_code','original_purpose_code'], seller: ['assignor','seller','transferor','licensee'], buyer: ['assignee','buyer','transferee','applicant'], status: ['status','application status','status description','current status code','current_status_code','processing_status'], filed: ['date filed','filed date','filing date','received date','aapp_receipt_date','original_filing_date'], statusDate: ['status date','action date','date status','grant date','last action date','status_date'] };
const key = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const getValue = (row, names) => { const keys=Object.keys(row), wanted=names.map(key); const exact=keys.find(k=>wanted.includes(key(k))); if(exact)return String(row[exact]??'').trim(); const suffix=keys.find(k=>wanted.some(n=>n.length>3&&key(k).endsWith(n))); return suffix?String(row[suffix]??'').trim():''; };
function normalize(row, file) { const record=Object.fromEntries(Object.entries(aliases).map(([name,names])=>[name,getValue(row,names)])); record.source_file=file; record.review=!record.file||!record.call||!record.status; record.isTransaction=file==='application.dat'||/assign|transfer|sale|control|renew|modif|permit|license|application|ownership|new/i.test(record.type+' '+record.status); return record; }
function splitLine(line, delimiter) { const cells = []; let cell = '', quoted = false; for (let i=0; i<line.length; i++) { const c=line[i], next=line[i+1]; if (c==='"' && quoted && next==='"') { cell+='"'; i++; continue; } if (c==='"') { quoted=!quoted; continue; } if (c===delimiter && !quoted) { cells.push(cell); cell=''; continue; } cell+=c; } cells.push(cell); return cells; }
function parse(text, file) { const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()); if(lines.length<2)return[]; const delimiter=lines[0].includes('|')?'|':(lines[0].includes('\t')?'\t':','); const headers=splitLine(lines[0],delimiter).map(x=>x.trim()); if(!headers.some(x=>/call|station|file|status|purpose|service/i.test(x)))return[]; return lines.slice(1).map(line=>{const cells=splitLine(line,delimiter); return normalize(Object.fromEntries(headers.map((h,i)=>[h,cells[i]??''])),file);}); }
function serviceMatches(row, service) { if(service==='all')return true; const text=row.service.trim().toLowerCase(); return service==='television'?/tv|television|class ?a|lptv|dtv|^ttv$|^dts?$|^tx$|^t$/.test(text):/am|fm|radio|translator|lpfm|booster|^fx$|^fb$/.test(text); }
function createRowStream(file,onRow){
  const decoder=new TextDecoder(); let buffer=''; let headers=null; let delimiter='|';
  const consume=line=>{
    if(!line.trim()) return;
    if(!headers){ delimiter=line.includes('|')?'|':(line.includes('\t')?'\t':','); headers=splitLine(line,delimiter).map(x=>x.trim()).filter((x,i,a)=>!(i===a.length-1&&x==='^')); return; }
    const cells=splitLine(line,delimiter); const row=Object.fromEntries(headers.map((h,i)=>[h,String(cells[i]??'').replace(/\^$/,'')])); onRow(normalize(row,file));
  };
  return { push(bytes,final=false){ buffer+=decoder.decode(bytes,{stream:!final}); const lines=buffer.split(/\r?\n/); buffer=lines.pop()||''; for(const line of lines) consume(line); if(final){ if(buffer.trim()) consume(buffer); buffer=''; } } };
}
function partyName(row){
  const legal=getValue(row,['legal party name','entity name','company name','organization name','party name','name']);
  const first=getValue(row,['first name','given name']);
  const middle=getValue(row,['middle name','middle initial']);
  const last=getValue(row,['last name','surname']);
  const dba=getValue(row,['dba name','doing business as']);
  return legal||[first,middle,last].filter(Boolean).join(' ')||dba;
}
function partyRole(row){ return getValue(row,['party role code','party role','role code','role','party role discrim','applicant indicator']); }
function createPartyStream(onParty){
  const decoder=new TextDecoder(); let buffer=''; let headers=null; let delimiter='|';
  const consume=line=>{
    if(!line.trim()) return;
    if(!headers){ delimiter=line.includes('|')?'|':(line.includes('\t')?'\t':','); headers=splitLine(line,delimiter).map(x=>x.trim()).filter((x,i,a)=>!(i===a.length-1&&x==='^')); return; }
    const cells=splitLine(line,delimiter); const row=Object.fromEntries(headers.map((h,i)=>[h,String(cells[i]??'').replace(/\^$/,'')]));
    const applicationId=getValue(row,['application id','application_id','aapp application id','apar aapp application id']); const name=partyName(row);
    if(applicationId&&name) onParty(applicationId,name,partyRole(row));
  };
  return { push(bytes,final=false){ buffer+=decoder.decode(bytes,{stream:!final}); const lines=buffer.split(/\r?\n/); buffer=lines.pop()||''; for(const line of lines) consume(line); if(final){ if(buffer.trim()) consume(buffer); buffer=''; } } };
}
function createOwnershipStream(onRow){
  const decoder=new TextDecoder(); let buffer=''; let facilityIndex=-1; let serviceIndex=-1;
  const consume=line=>{
    if(!line.trim()) return;
    if(facilityIndex<0){ const headers=line.split('|').map(x=>x.trim().toLowerCase()); facilityIndex=headers.indexOf('facility_id'); serviceIndex=headers.indexOf('service'); return; }
    const cells=line.split('|'); const facilityId=String(cells[facilityIndex]??'').trim(); const service=String(cells[serviceIndex]??'').trim(); if(facilityId&&service) onRow(facilityId,service);
  };
  return { push(bytes,final=false){ buffer+=decoder.decode(bytes,{stream:!final}); const lines=buffer.split(/\\r?\\n/); buffer=lines.pop()||''; for(const line of lines) consume(line); if(final){ if(buffer.trim()) consume(buffer); buffer=''; } } };
}
const applicationRows=[]; const facilityService=new Map(); const facilityIdByApplication=new Map(); const facilityIdService=new Map(); const applicationParties=new Map(); const debug=[]; const wanted=new Set(['application.dat','application_facility.dat','ownership_reports_stations.dat','app_party.dat']);
const unzip=new Unzip(file=>{
  const relevant=wanted.has(file.name); debug.push({name:file.name,size:file.originalSize||0});
  if(!relevant) return;
  const parser=file.name==='ownership_reports_stations.dat' ? createOwnershipStream((facilityId,service)=>facilityIdService.set(facilityId,service)) : file.name==='app_party.dat' ? createPartyStream((applicationId,name,role)=>{ const current=applicationParties.get(applicationId)||{all:[],seller:[],buyer:[]}; if(!current.all.includes(name)) current.all.push(name); const normalizedRole=role.toLowerCase(); if(/assignor|transferor|licensee/.test(normalizedRole)&&!current.seller.includes(name)) current.seller.push(name); if(/assignee|transferee/.test(normalizedRole)&&!current.buyer.includes(name)) current.buyer.push(name); applicationParties.set(applicationId,current); }) : createRowStream(file.name,row=>{ if(file.name==='application_facility.dat'){ if(row.applicationId&&row.facilityId) facilityIdByApplication.set(row.applicationId,row.facilityId); if(row.applicationId&&row.service) facilityService.set(row.applicationId,row.service); } else if(applicationRows.length<500000) applicationRows.push(row); });
  file.ondata=(err,data,final)=>{ if(err) throw err; parser.push(data,final); };
  file.start();
});
unzip.register(UnzipInflate);
const reader=createReadStream(process.env.FCC_LMS_ZIP||'Current_LMS_Dump.zip',{highWaterMark:1024*1024});
for await (const chunk of reader) unzip.push(new Uint8Array(chunk));
unzip.push(new Uint8Array(0),true);
const all=[]; const seen=new Set();
for(const row of applicationRows){ row.service=row.service||facilityService.get(row.applicationId)||facilityIdService.get(facilityIdByApplication.get(row.applicationId))||''; row.file=row.file||row.applicationId; if(!row.isTransaction) continue; const parties=applicationParties.get(row.applicationId)||{all:[],seller:[],buyer:[]}; row.seller=row.seller||parties.seller.join(' · '); row.buyer=row.buyer||parties.buyer.join(' · '); row.parties=parties.all.join(' · '); const identity=(row.applicationId||'')+'|'+row.file+'|'+row.call+'|'+row.type; if(seen.has(identity)) continue; seen.add(identity); all.push(row); }
const fetched_at=new Date().toISOString(); const publicRecord=({source_file,isTransaction,...record})=>record; for(const service of ['all','radio','television']){ const data=all.filter(row=>serviceMatches(row,service)); const output=service==='all'?data.slice(0,100000):data; await writeFile('cache-'+service+'.json',JSON.stringify({data:output.map(publicRecord),connected:true,service,source:'FCC LMS Current_LMS_Dump.zip',fetched_at,review_count:output.filter(row=>row.review).length})); }
await writeFile('cache-debug.json',JSON.stringify({fetched_at,files:debug,party_application_count:applicationParties.size})); console.log(JSON.stringify({fetched_at,records:all.length,radio:all.filter(r=>serviceMatches(r,'radio')).length,television:all.filter(r=>serviceMatches(r,'television')).length,party_application_count:applicationParties.size}));
