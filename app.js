"use strict";
const YEARS=[2018,2019,2020,2021,2022,2023,2024];
const PARTIAL={2018:"2018 partial",2024:"Dec ’24 runout"};
const fmtM=v=>v>=1000?"$"+(v/1000).toFixed(1)+"B":"$"+(v<10?v.toFixed(1):Math.round(v))+"M";
const fmtPer=v=>"$"+(v>=100?Math.round(v):v.toFixed(1));
const growthClass=m=>m==null?"g-lo":(m>=2.5?"hi":(m>=1.5?"md":"lo"));
const ALL_NAME="All 10 categories";

let NATIONAL, US_FEATURES, COUNTY_FEATURES, sel=null, metric="total", attr="prov", year=2023, playing=null, trajChart=null;
let geo="US", STATEDATA=null; const stateCache={};
let path=null;

Promise.all([
  fetch("data/national.json").then(r=>r.json()),
  fetch("data/us-counties.topo.json").then(r=>r.json())
]).then(([natl,ctopo])=>{
  NATIONAL=natl;
  // both state and county boundaries come from one clean topology (the GeoJSON us-states.json
  // had a corrupt Virginia ring that smeared across the canvas)
  US_FEATURES=topojson.feature(ctopo, ctopo.objects.states).features.filter(f=>NATIONAL.states[f.id]);
  COUNTY_FEATURES=topojson.feature(ctopo, ctopo.objects.counties).features;
  buildGeoSelector();
  buildCaveats();
  document.getElementById("cov").textContent=NATIONAL.meta.county_coverage_pct+"%";
  setGeo("US", true);
});

/* ---------- geography ---------- */
function buildGeoSelector(){
  const sel2=document.getElementById("geoSel");
  const opts=['<option value="US">United States (by state)</option>'];
  Object.keys(NATIONAL.states).sort((a,b)=>NATIONAL.states[a].name.localeCompare(NATIONAL.states[b].name))
    .forEach(st=>opts.push(`<option value="${st}">${NATIONAL.states[st].name}</option>`));
  sel2.innerHTML=opts.join("");
  sel2.addEventListener("change",e=>setGeo(e.target.value));
}
function setGeo(g, first){
  stopPlay();
  if(g==="US"){
    geo="US"; STATEDATA=null; afterGeo(first);
  } else if(stateCache[g]){
    geo=g; STATEDATA=stateCache[g]; afterGeo(first);
  } else {
    fetch(`data/states/${g}.json`).then(r=>r.json()).then(d=>{ stateCache[g]=d; geo=g; STATEDATA=d; afterGeo(first); });
  }
}
function afterGeo(first){
  const label = geo==="US" ? "United States" : NATIONAL.states[geo].name;
  document.getElementById("geoLabel").textContent=label;
  document.getElementById("trajScope").textContent=label;
  document.getElementById("topUnitLabel").textContent = geo==="US" ? "states" : "counties";
  document.getElementById("geoSel").value=geo;
  buildLandscape();
  renderMapStructure();
  // keep current selection if it still exists (ALL always valid); default to ALL
  const cats=currentCategories();
  const prev = sel ? sel.name : ALL_NAME;
  const valid = prev===ALL_NAME || cats.find(c=>c.name===prev);
  select(valid ? prev : ALL_NAME);
}

/* ---------- category objects per current geography ---------- */
function currentCategories(){
  if(geo==="US") return NATIONAL.categories;
  // build per-state landscape from series_state[cat][geo].prov
  return NATIONAL.categories.map(base=>{
    const node=NATIONAL.series_state[base.name]?.[geo];
    const sw={}; YEARS.forEach(y=> sw[y]= node? (node.prov[y]||0):0 );
    const b19=sw[2019]||0, b23=sw[2023]||0;
    return {name:base.name,tier:base.tier,note:base.note,statewide:sw,
      mult_19_23:b19>0?+(b23/b19).toFixed(2):null,
      cagr_19_23:b19>0?+(((b23/b19)**0.25-1)*100).toFixed(1):null,
      level_2023:+(b23).toFixed(1),
      poc_shift_pct: STATEDATA?.poc_shift?.[base.name] ?? null};
  });
}

function allObj(){
  const cats=currentCategories(), sw={};
  YEARS.forEach(y=> sw[y]=cats.reduce((s,c)=>s+(c.statewide[y]||0),0));
  const b19=sw[2019]||0,b23=sw[2023]||0;
  return {name:ALL_NAME,tier:0,note:"",isAll:true,statewide:sw,
    mult_19_23:b19>0?+(b23/b19).toFixed(2):null,
    cagr_19_23:b19>0?+(((b23/b19)**0.25-1)*100).toFixed(1):null,
    level_2023:+b23.toFixed(1),
    poc_shift_pct: geo==="US"? NATIONAL.meta.poc_reattr_pct : null};
}

/* ---------- value lookups ---------- */
function unitSeries(catName, unitId){
  if(geo==="US") return NATIONAL.series_state[catName]?.[unitId];
  return STATEDATA.series[catName]?.[unitId];
}
function unitPop(unitId){ return geo==="US" ? NATIONAL.states[unitId]?.pop : STATEDATA.counties[unitId]?.pop; }
function unitName(unitId){ return geo==="US" ? (NATIONAL.states[unitId]?.name||unitId) : (STATEDATA.counties[unitId]?.name||unitId); }
function rawUnit(catName, unitId, yr){
  if(catName===ALL_NAME) return currentCategories().reduce((a,c)=>a+rawUnit(c.name,unitId,yr),0);
  const s=unitSeries(catName,unitId); return s?((s[attr]||{})[yr]||0):0;
}
function unitValue(catName, unitId, yr){
  let v=rawUnit(catName,unitId,yr);
  if(metric==="percap"){ const p=unitPop(unitId); v=p? v*1e6/p : 0; }
  return v;
}
function currentUnitIds(){ return geo==="US" ? Object.keys(NATIONAL.states) : Object.keys(STATEDATA.counties); }
function catMax(catName){
  let mx=0; currentUnitIds().forEach(u=>YEARS.forEach(y=>{ mx=Math.max(mx,unitValue(catName,u,y)); }));
  return mx||1;
}

/* ---------- landscape ---------- */
function sparkline(cat){
  const v=YEARS.map(y=>cat.statewide[y]||0), max=Math.max(...v,1e-6);
  const W=160,H=34,n=v.length,gap=4,bw=(W-gap*(n-1))/n, cls="bar-"+growthClass(cat.mult_19_23);
  let bars="";
  v.forEach((val,i)=>{ const h=Math.max(2,val/max*(H-3)),x=i*(bw+gap),y=H-h,op=(i===0||i===n-1)?.35:1;
    bars+=`<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" opacity="${op}"/>`; });
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}
function buildLandscape(){
  const tiers={1:"Tier 1 — flagship volume + active enforcement",2:"Tier 2 — high conviction volume, tractable data",3:"Tier 3 — emerging / structurally similar"};
  const cats=currentCategories(), host=document.getElementById("landscape"); host.innerHTML="";
  // "All categories" summary card (combined total)
  const all=allObj(), agc=growthClass(all.mult_19_23);
  const aMult=all.mult_19_23==null?"—":(all.mult_19_23>=10?Math.round(all.mult_19_23):all.mult_19_23.toFixed(1))+"×";
  const aCagr=all.cagr_19_23==null?"":(all.cagr_19_23>=0?"+":"")+all.cagr_19_23+"%/yr";
  const allCard=document.createElement("div");
  allCard.className="card card-all"; allCard.dataset.name=ALL_NAME;
  allCard.innerHTML=`<div class="all-left"><div class="nm">All 10 categories — combined</div>
      <div class="sm" style="margin-top:2px">click to map the total · click any card below to isolate one</div></div>
    <div class="all-spark">${sparkline(all)}</div>
    <div class="all-stat"><div class="mult g-${agc}">${aMult}</div><div class="sm">’19→’23 · ${aCagr}</div></div>
    <div class="all-stat"><div class="lvl">${fmtM(all.statewide[2023]||0)}</div><div class="sm">2023 total</div></div>`;
  allCard.onclick=()=>select(ALL_NAME);
  host.appendChild(allCard);
  [1,2,3].forEach(t=>{
    const band=document.createElement("div"); band.className="tier-band";
    band.innerHTML=`<div class="tier-label">${tiers[t]}</div>`;
    const grid=document.createElement("div"); grid.className="cards";
    cats.filter(c=>c.tier===t).forEach(c=>{
      const gc=growthClass(c.mult_19_23), card=document.createElement("div");
      card.className="card"; card.dataset.name=c.name;
      const multTxt=c.mult_19_23==null?"—":(c.mult_19_23>=10?Math.round(c.mult_19_23):c.mult_19_23.toFixed(1))+"×";
      const cagrTxt=c.cagr_19_23==null?"":(c.cagr_19_23>=0?"+":"")+c.cagr_19_23+"%/yr";
      const noteI=c.note?`<span class="note-i" title="${c.note}">&#9432;</span>`:"";
      card.innerHTML=`<div class="nm">${c.name}${noteI}</div>${sparkline(c)}
        <div class="row"><div><div class="mult g-${gc}">${multTxt}</div><div class="sm">’19→’23 · ${cagrTxt}</div></div>
        <div><div class="lvl">${fmtM(c.statewide[2023]||0)}</div><div class="sm">2023</div></div></div>`;
      card.onclick=()=>select(c.name);
      grid.appendChild(card);
    });
    band.appendChild(grid); host.appendChild(band);
  });
}
function buildCaveats(){
  const extra=["Counties/states are <em>provider</em> location, not patient residence — providers may serve patients across lines.",
    "“Per resident” divides by the unit's population; a low-population unit served by a regional provider can show an inflated rate — read it as a screening flag."];
  document.getElementById("caveats").innerHTML=NATIONAL.meta.caveats.concat(extra).map(c=>`<li>${c}</li>`).join("");
}

/* ---------- map ---------- */
function mapFeatures(){
  return geo==="US" ? US_FEATURES : COUNTY_FEATURES.filter(f=>String(f.id).slice(0,2)===geo);
}
function renderMapStructure(){
  const feats=mapFeatures(), W=560,H=520;
  d3.select("#map svg").remove();
  const proj = geo==="US" ? d3.geoAlbersUsa().fitSize([W,H],{type:"FeatureCollection",features:feats})
                          : d3.geoMercator().fitSize([W,H],{type:"FeatureCollection",features:feats});
  path=d3.geoPath(proj);
  const svg=d3.select("#map").append("svg").attr("viewBox",`0 0 ${W} ${H}`);
  svg.selectAll("path").data(feats).join("path").attr("class","county").attr("d",path)
    .on("mousemove",(e,d)=>showTip(e,d)).on("mouseleave",hideTip);
}
function paintMap(){
  const mx=catMax(sel.name), color=d3.scaleSequential(d3.interpolateYlOrRd).domain([0,mx]);
  d3.select("#map").selectAll("path.county").transition().duration(playing?260:0)
    .attr("fill",d=>{ const v=unitValue(sel.name,String(d.id),year); return v>0?color(v):"#eee"; });
  document.getElementById("legMax").textContent = metric==="percap"?fmtPer(mx):fmtM(mx);
  document.getElementById("legBar").style.background="linear-gradient(to right,"+d3.range(0,1.01,.1).map(t=>color(t*mx)).join(",")+")";
}
function showTip(e,d){
  const id=String(d.id), v=unitValue(sel.name,id,year);
  const disp=metric==="percap"?fmtPer(v)+" / resident":fmtM(v);
  const suffix=geo==="US"?"":" County";
  const tip=document.getElementById("tip");
  tip.innerHTML=`<b>${unitName(id)}${suffix}</b><br>${sel.name}<br>${year}: ${disp}`;
  tip.style.opacity=1; tip.style.left=(e.clientX+13)+"px"; tip.style.top=(e.clientY+13)+"px";
}
function hideTip(){ document.getElementById("tip").style.opacity=0; }
function updateMapSub(){
  const base=metric==="percap"?"Paid per resident":"Paid amount";
  const unit=geo==="US"?"state":"county";
  let geoTxt, extra="";
  if(attr==="poc"){ geoTxt=`by point-of-care ${unit} (servicing provider)`;
    const sh=sel&&sel.poc_shift_pct!=null?sel.poc_shift_pct:null;
    if(sh!=null) extra=` · ${sh}% of this category re-attributed vs billing`;
  } else geoTxt=`by billing-provider ${unit}`;
  document.getElementById("mapSub").innerHTML=base+" "+geoTxt+extra;
}

/* ---------- right panel ---------- */
function paintTraj(){
  const v=YEARS.map(y=>sel.statewide[y]||0);
  if(trajChart) trajChart.destroy();
  trajChart=new Chart(document.getElementById("traj"),{type:"line",
    data:{labels:YEARS,datasets:[{data:v,borderColor:"#185fa5",backgroundColor:"rgba(24,95,165,.10)",fill:true,tension:.25,
      pointRadius:YEARS.map(y=>y===year?6:3.5),
      pointBackgroundColor:YEARS.map(y=>y===year?"#a32d2d":(PARTIAL[y]?"#c9c6bd":"#185fa5")),
      pointBorderColor:"#fff",pointBorderWidth:1.5,borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>fmtM(c.parsed.y)+(PARTIAL[c.label]?"  ("+PARTIAL[c.label]+")":"")}}},
      scales:{y:{ticks:{callback:v=>fmtM(v),font:{size:11}},grid:{color:"#eee"}},x:{ticks:{font:{size:11}},grid:{display:false}}}}});
  document.getElementById("trajSub").textContent=NATIONAL.meta.metric;
}
function paintTopUnits(){
  const rows=currentUnitIds().map(u=>({u,nm:unitName(u),v:unitValue(sel.name,u,year)}))
    .filter(r=>r.v>0).sort((a,b)=>b.v-a.v).slice(0,8);
  const mx=rows.length?rows[0].v:1;
  document.getElementById("tcYear").textContent=year;
  document.getElementById("topUnits").innerHTML=rows.map(r=>{
    const disp=metric==="percap"?fmtPer(r.v)+"/res":fmtM(r.v);
    return `<div class="tcrow"><span class="tcname">${r.nm}</span><span class="tcbar" style="width:${Math.max(2,r.v/mx*120)}px"></span><span class="tcval">${disp}</span></div>`;
  }).join("")||`<div class="sm" style="color:var(--hint)">No spend in this geography.</div>`;
}

/* ---------- selection + controls ---------- */
function select(name){
  if(name===ALL_NAME){ sel=allObj(); }
  else { const cats=currentCategories(); sel=cats.find(c=>c.name===name)||cats[0]; }
  if(!sel) return;
  document.querySelectorAll(".card").forEach(el=>el.classList.toggle("active",el.dataset.name===sel.name));
  document.getElementById("mapTitle").textContent=sel.name;
  const gc=growthClass(sel.mult_19_23);
  document.getElementById("stMult").innerHTML=`<span class="g-${gc}">${sel.mult_19_23==null?"—":(sel.mult_19_23>=10?Math.round(sel.mult_19_23):sel.mult_19_23.toFixed(1))+"×"}</span>`;
  document.getElementById("stCagr").textContent=sel.cagr_19_23==null?"—":(sel.cagr_19_23>=0?"+":"")+sel.cagr_19_23+"%";
  document.getElementById("stLvl").textContent=fmtM(sel.statewide[2023]||0);
  updateMapSub(); paintMap(); paintTraj(); paintTopUnits();
}
function setYear(y){
  year=+y; document.getElementById("yearOut").textContent=y;
  document.getElementById("yrFlag").textContent=PARTIAL[y]?("⚠ "+PARTIAL[y]):"";
  document.getElementById("yearSlider").value=y;
  paintMap(); paintTopUnits();
  if(trajChart){ trajChart.data.datasets[0].pointRadius=YEARS.map(yy=>yy===year?6:3.5);
    trajChart.data.datasets[0].pointBackgroundColor=YEARS.map(yy=>yy===year?"#a32d2d":(PARTIAL[yy]?"#c9c6bd":"#185fa5"));
    trajChart.update("none"); }
}
function wireControls(){
  document.getElementById("yearSlider").addEventListener("input",e=>{ stopPlay(); setYear(e.target.value); });
  document.getElementById("metricSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return;
    metric=b.dataset.m; document.querySelectorAll("#metricSeg button").forEach(x=>x.classList.toggle("on",x===b));
    updateMapSub(); paintMap(); paintTopUnits(); });
  document.getElementById("attrSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return;
    attr=b.dataset.a; document.querySelectorAll("#attrSeg button").forEach(x=>x.classList.toggle("on",x===b));
    updateMapSub(); paintMap(); paintTopUnits(); });
  document.getElementById("playBtn").addEventListener("click",togglePlay);
}
function togglePlay(){ playing?stopPlay():startPlay(); }
function startPlay(){ document.getElementById("playBtn").textContent="❚❚"; if(year>=2024) setYear(2018);
  playing=setInterval(()=>{ if(year>=2024){stopPlay();return;} setYear(year+1); },900); }
function stopPlay(){ if(playing){clearInterval(playing);playing=null;} document.getElementById("playBtn").textContent="▶"; }
wireControls();
