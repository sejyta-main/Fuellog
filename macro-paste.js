(function(root){
  "use strict";
  function parseFuelMacros(input){
  const raw=String(input||"").trim();
  if(!raw) return {ok:false,error:"Paste a meal with calories, protein, carbs and fat first."};
  const clean=s=>String(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\*\*/g,"").toLowerCase();
  const number="\\d[\\d.,]*";
  const value=rawNumber=>{
    const s=String(rawNumber).replace(/[^\d.,]/g,"");
    if(!s) return NaN;
    const comma=s.lastIndexOf(","), dot=s.lastIndexOf(".");
    if(comma>=0&&dot>=0){
      const decimal=comma>dot?",":".";
      return Number(s.replace(decimal===","?/\./g:/,/g,"").replace(decimal,"."));
    }
    const separator=comma>=0?",":".";
    const parts=s.split(separator);
    if(parts.length>2) return Number(parts.join(""));
    if(parts.length===2&&parts[1].length===3&&parts[0]!=="0") return Number(parts.join(""));
    return Number(s.replace(",","."));
  };
  const extract=(text,longLabels,shortLabels)=>{
    const s=clean(text);
    const long=longLabels.join("|"), all=longLabels.concat(shortLabels).join("|");
    const prefix=new RegExp("(?:^|[^a-z0-9])(?:"+all+")\\s*(?:[:=]\\s*|\\s+)("+number+")","i");
    const suffix=new RegExp("("+number+")\\s*(?:g|gr|grs|gramos?|grams?)\\s*(?:de\\s+)?(?:"+long+")\\b","i");
    const a=s.match(prefix)||s.match(suffix);
    return a?value(a[1]):null;
  };
  const extractCalories=text=>{
    const s=clean(text);
    const suffix=s.match(new RegExp("("+number+")\\s*(?:kcal|kilocalorias?|calorias?|calories)\\b","i"));
    const prefix=s.match(new RegExp("(?:kcal|kilocalorias?|calorias?|calories)\\s*[:=]?\\s*("+number+")","i"));
    return suffix?value(suffix[1]):prefix?value(prefix[1]):null;
  };
  const read=text=>({
    kcal:extractCalories(text),
    p:extract(text,["proteinas?","proteins?","prot"],["p"]),
    c:extract(text,["carbohidratos?","carbohydrates?","carbs?","carb"],["c"]),
    f:extract(text,["grasas?","fats?","fat"],["g","f"])
  });
  const lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const complete=lines.map((line,index)=>({line,index,data:read(line)}))
    .filter(x=>Object.values(x.data).every(v=>v!==null&&Number.isFinite(v)));
  const priority=x=>{
    const s=clean(x.line);
    return (/para\s+(?:registrar\s+en\s+)?fuel/.test(s)?30:0)+(/\btotal\b/.test(s)?20:0)+(/\|/.test(s)?5:0);
  };
  complete.sort((a,b)=>priority(b)-priority(a)||a.index-b.index);
  const chosen=complete[0];
  const data=chosen?chosen.data:read(raw);
  const missing=Object.entries({kcal:"calories",p:"protein",c:"carbs",f:"fat"})
    .filter(([key])=>data[key]===null||!Number.isFinite(data[key])).map(([,label])=>label);
  if(missing.length) return {ok:false,error:"Could not find "+missing.join(", ")+". Paste all four values in one line, e.g. 500 kcal | P 36 g | C 34 g | F 24 g."};
  if(data.kcal<0||data.kcal>10000||[data.p,data.c,data.f].some(x=>x<0||x>1000))
    return {ok:false,error:"One or more numbers are outside reasonable limits. Check the pasted text."};
  const candidateLine=(chosen?chosen.line:lines[0]||"").replace(/\*\*/g,"").trim();
  let name="";
  const nameMatch=candidateLine.match(/^(.{2,110}?)\s*[:–—-]\s*(?:(?:calories|calorias|kcal)\s*[:=]?\s*)?(?=\d[\d.,]*)/i);
  if(nameMatch) name=nameMatch[1].trim();
  const discard=s=>/^(?:para\s+fuel|para\s+registrar|fuel|total|macros?|meal|comida|calorias?|calories|estimacion)/i.test(clean(s));
  if(!name||discard(name)){
    name="";
    for(const line of lines.slice(0,8)){
      const c=line.replace(/^[#*\s-]+/,"").replace(/\*\*/g,"").trim();
      if(c.length>=4&&c.length<=100&&!/\d[\d.,]*\s*kcal/i.test(c)&&!discard(c)&&!/[.!?]$/.test(c)){
        name=c;break;
      }
    }
  }
  if(!name||discard(name)) name="Imported meal";
  return {ok:true,name,kcal:data.kcal,p:data.p,c:data.c,f:data.f};
}
  root.FuelMacroPaste={parse:parseFuelMacros};
})(typeof window!=="undefined"?window:globalThis);
