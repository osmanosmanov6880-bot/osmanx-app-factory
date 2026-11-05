import {bad} from '../common/http.mjs';

export const CSV_HEADERS=['full_name','phone','email','source','notes'];
const MAX_INPUT_BYTES=115*1024;
const MAX_RECORDS=500;
// CSV parser accepts comma and semicolon formats, quoted separators/newlines, Excel UTF-8 BOM.
// It deliberately rejects malformed quoting rather than silently shifting columns.
export function parseClientCsv(input){
  if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>MAX_INPUT_BYTES)bad(413,'CSV: максимум 115 КБ за одну загрузку');
  const text=input.replace(/^\ufeff/,'');
  if(!text.trim())bad(400,'CSV пуст');
  const firstLine=text.slice(0,text.indexOf('\n')>=0?text.indexOf('\n'):text.length);
  const delimiter=(firstLine.match(/;/g)||[]).length>(firstLine.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted && text[i+1]==='"'){cell+='"';i++;}
      else if(quoted){quoted=false;closed=true;}
      else if(!cell&&!closed){quoted=true;}
      else bad(400,`CSV: неправильные кавычки (символ ${i+1})`);
      continue;
    }
    if(quoted){cell+=c;continue;}
    if(c===delimiter){row.push(cell);cell='';closed=false;continue;}
    if(c==='\n'||c==='\r'){
      row.push(cell);cell='';closed=false;
      if(row.some(x=>x.trim()))rows.push(row);
      row=[];if(c==='\r'&&text[i+1]==='\n')i++;
      if(rows.length>MAX_RECORDS+1)bad(413,`CSV: максимум ${MAX_RECORDS} строк клиентов`);
      continue;
    }
    if(closed && c!==' ' && c!=='\t')bad(400,'CSV: лишние символы после закрывающей кавычки');
    cell+=c;
  }
  if(quoted)bad(400,'CSV: не закрыты кавычки');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  const header=(rows.shift()||[]).map(x=>x.trim().toLowerCase());
  if(header.length!==CSV_HEADERS.length||new Set(header).size!==header.length||CSV_HEADERS.some(x=>!header.includes(x)))
    bad(400,'CSV: нужны столбцы full_name, phone, email, source, notes');
  if(rows.length>MAX_RECORDS)bad(413,`CSV: максимум ${MAX_RECORDS} строк клиентов`);
  if(!rows.length)bad(400,'CSV: нет строк с клиентами');
  return rows.map((r,i)=>{
    if(r.length!==header.length)bad(400,`CSV: строка ${i+2}, количество столбцов не совпадает`);
    return Object.fromEntries(header.map((key,col)=>{
      let value=r[col].trim();
      // Excel escaping added by our exporter is reversed during re-import.
      if(/^'[=+\-@]/.test(value))value=value.slice(1);
      return [key,value];
    }));
  });
}
const safeCell=value=>{
  let s=String(value??'');
  if(/^[\s\u0000-\u001f]*[=+\-@]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
export function clientsToCsv(rows){
  return '\ufeff'+[CSV_HEADERS.join(','),...rows.map(row=>CSV_HEADERS.map(key=>safeCell(row[key])).join(','))].join('\r\n')+'\r\n';
}
export function normalizePhone(value){return String(value||'').replace(/[^0-9+]/g,'').toLowerCase()}
export function planClientImport(db,csv,normalizeClient){
  const rows=parseClientCsv(csv);
  const existing=db.prepare('SELECT phone,email FROM clients WHERE archived_at IS NULL').all();
  const phones=new Set(existing.map(x=>normalizePhone(x.phone)).filter(x=>x.length>=5));
  const emails=new Set(existing.map(x=>x.email.toLowerCase()).filter(Boolean));
  const ready=[],errors=[],examples=[];let duplicates=0;
  for(let i=0;i<rows.length;i++){
    try{
      const data=normalizeClient(rows[i]);
      const phone=normalizePhone(data.phone),email=data.email.toLowerCase();
      if((phone.length>=5&&phones.has(phone))||(email&&emails.has(email))){duplicates++;continue;}
      if(phone.length>=5)phones.add(phone);
      if(email)emails.add(email);
      ready.push(data);
      if(examples.length<3)examples.push({full_name:data.full_name,phone:data.phone,email:data.email});
    }catch(e){if(errors.length<20)errors.push({row:i+2,error:e.message});}
  }
  return {total:rows.length,ready:ready.length,duplicates,invalid:rows.length-ready.length-duplicates,examples,errors,records:ready};
}
