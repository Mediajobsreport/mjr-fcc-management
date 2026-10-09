import { unzipSync, strFromU8 } from 'fflate';
import { writeFile } from 'node:fs/promises';

const source = 'https://enterpriseefiling.fcc.gov/dataentry/api/download/dbfile/Current_LMS_Dump.zip';
const aliases = { applicationId: ['application id','application_id','aapp_application_id','afac_application_id'], call: ['callsign','call sign','station','station callsign','call_sign','app_callsign','aapp_callsign'], city: ['city','community','station city','community of license','afac_community_city'], state: ['state','state code','state abbreviation','afac_community_state_code'], service: ['service','service code','facility type','service type','app service','service_code','afac_facility_type','afac_station_type'], file: ['file number','filenumber','file_num','aapp_file_num','application number','app number','file_no'], type: ['purpose','transaction type','application purpose','form','application type','purpose description','purpose_code','original_purpose_code'], seller: ['assignor','seller','transferor','licensee'], buyer: ['assignee','buyer','transferee','applicant'], status: ['status','application status','status description','current status code','current_status_code','processing_status'], filed: ['date filed','filed date','filing date','received date','aapp_receipt_date','original_filing_date'], statusDate: ['status date','action date','date status','grant date','last action date','status_date'] };
const key = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const getValue = (row, names) => { const keys=Object.keys(row), wanted=names.map(key); const exact=keys.find(k=>wanted.includes(key(k))); if(exact)return String(row[exact]??'').trim(); const suffix=keys.find(k=>wanted.some(n=>n.length>3&&key(k).endsWith(n))); return suffix?String(row[suffix]??'').trim():''; };
function normalize(row, file) { const record=Object.fromEntries(Object.entries(aliases).map(([name,names])=>[name,getValue(row,names)])); record.source_file=file; record.review=!record.file||!record.call||!record.status; record.isTransaction=file==='application.dat'||/assign|transfer|sale|control|renew|modif|permit|license|application|ownership|new/i.test(record.type+' '+record.status); return record; }
function splitLine(line, delimiter) { const cells = []; let cell = '', quoted = false; for (let i=0; i<line.length; i++) { const c=line[i], next=line[i+1]; if (c==='"' && quoted && next==='"') { cell+='"'; i++; continue; } if (c==='"') { quoted=!quoted; continue; } if (c===delimiter && !quoted) { cells.push(cell); cell=''; continue; } cell+=c; } cells.push(cell); return cells; }
function parse(text, file) { const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()); if(lines.length<2)return[]; const delimiter=lines[0].includes('|')?'|':(lines[0].includes('\t')?'\t':','); const headers=splitLine(lines[0],delimiter).map(x=>x.trim()); if(!headers.some(x=>/call|station|file|status|purpose|service/i.test(x)))return[]; return lines.slice(1).map(line=>{const cells=splitLine(line,delimiter); return normalize(Object.fromEntries(headers.map((h,i)=>[h,cells[i]??''])),file);}); }
function serviceMatches(row, service) { if(service==='all')return true; const text=row.service.toLowerCase(); return service==='television'?/tv|television|class ?a|lptv|dtv/.test(text):/am|fm|radio|translator|lpfm/.test(text); }
const response=await fetch(source,{headers:{'User-Agent':'MJR FCC Management/1.0 (+https://mediajobsreport.com)',Accept:'application/zip'}}); if(!response.ok)throw new Error(`FCC LMS source returned HTTP ${response.status}`);
function streamRows(bytes,file,onRow){
  const decoder=new TextDecoder(); let buffer=''; let headers=null; let delimiter='|';
  const consume=line=>{
    if(!line.trim()) return;
    if(!headers){ delimiter=line.includes('|')?'|':(line.includes('\t')?'\t':','); headers=splitLine(line,delimiter).map(x=>x.trim()).filter((x,i,a)=>!(i===a.length-1&&x==='^')); return; }
    const cells=splitLine(line,delimiter); const row=Object.fromEntries(headers.map((h,i)=>[h,String(cells[i]??'').replace(/\^$/,'')])); onRow(normalize(row,file));
  };
  const size=1024*1024;
  for(let offset=0;offset<bytes.length;offset+=size){ buffer+=decoder.decode(bytes.subarray(offset,Math.min(offset+size,bytes.length)),{stream:offset+size<bytes.length}); const lines=buffer.split(/\r?\n/); buffer=lines.pop()||''; for(const line of lines) consume(line); }
  buffer+=decoder.decode(); if(buffer.trim()) consume(buffer);
}
const files=unzipSync(new Uint8Array(await response.arrayBuffer())); const debug=[]; let applicationBytes=null; let facilityBytes=null;
for(const [name,bytes] of Object.entries(files)){ const probe=strFromU8(bytes.slice(0,Math.min(bytes.length,200000))); const firstLine=probe.split(/\r?\n/).find(line=>line.trim())||''; debug.push({name,size:bytes.length,firstLine:firstLine.slice(0,500)}); if(name==='application.dat') applicationBytes=bytes; if(name==='application_facility.dat') facilityBytes=bytes; }
if(!applicationBytes||!facilityBytes) throw new Error('Required FCC application tables were not found');
const facilityService=new Map();
streamRows(facilityBytes,'application_facility.dat',row=>{ if(row.applicationId&&row.service) facilityService.set(row.applicationId,row.service); });
const all=[]; const seen=new Set();
streamRows(applicationBytes,'application.dat',row=>{ row.service=row.service||facilityService.get(row.applicationId)||''; row.file=row.file||row.applicationId; if(!row.isTransaction) return; const identity=(row.applicationId||'')+'|'+row.file+'|'+row.call+'|'+row.type; if(seen.has(identity)) return; seen.add(identity); if(all.length<100000) all.push(row); });
const fetched_at=new Date().toISOString(); for(const service of ['all','radio','television']){ const data=all.filter(row=>serviceMatches(row,service)); await writeFile('cache-'+service+'.json',JSON.stringify({data,connected:true,service,source:'FCC LMS Current_LMS_Dump.zip',fetched_at,review_count:data.filter(row=>row.review).length})); }
await writeFile('cache-debug.json',JSON.stringify({fetched_at,files:debug})); console.log(JSON.stringify({fetched_at,records:all.length,radio:all.filter(r=>serviceMatches(r,'radio')).length,television:all.filter(r=>serviceMatches(r,'television')).length}));
