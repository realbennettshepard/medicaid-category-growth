#!/usr/bin/env python3
"""Build verified NATIONAL Medicaid service-category temporospatial dataset.
Source: HHS OpenData medicaid-provider-spending (national, 2018-2024 monthly).
Outputs:
  data/national.json        category x STATE x year (both attributions) + national landscape
  data/states/<FIPS>.json   category x COUNTY x year (both attributions) for one state (lazy-loaded)
Geography: provider ZIP (NPPES via npi_zip) -> county FIPS (zip_county); state = FIPS[:2].
Two attributions: prov = billing provider county; poc = servicing provider county (else billing).
No fabricated values; every number aggregates real claim rows."""
import duckdb, pandas as pd, re, json, os
MED = os.path.expanduser("~/Documents/Medicade")
ROOT = os.path.expanduser("~/Documents/mn-medicaid-growth")
os.makedirs(f"{ROOT}/data/states", exist_ok=True)
con = duckdb.connect()
con.execute(f"ATTACH '{MED}/medicaid-provider-spending.duckdb' AS m (READ_ONLY)")
con.execute(f"CREATE VIEW npi_zip AS SELECT * FROM '{MED}/webapp/data/npi_zip.parquet'")
con.execute(f"CREATE VIEW zc AS SELECT * FROM '{MED}/webapp/data/zip_county.parquet'")
con.execute(f"CREATE VIEW pop AS SELECT * FROM '{MED}/webapp/data/county_population.parquet'")
con.execute("""CREATE TEMP TABLE npi_fips AS
  SELECT z.provider_npi AS npi, MIN(zc.county_fips) AS fips
  FROM npi_zip z JOIN zc ON z.postal_code=zc.postal_code GROUP BY z.provider_npi""")

XW = {
 "Personal Care Services / HCBS":["T1019","T1020","S5125","S5126","S5130","S5131","S5135","S5136","T1004","T1005","S5150","S5151","S5120","S5121","S5161","S5165","T2025","T2028","T2029"],
 "ABA / autism therapy":["97151","97152","97153","97154","97155","97156","97157","97158","0362T","0373T"],
 "Non-Emergency Medical Transport":["T2001","T2002","T2003","T2004","T2005","S0209","S0215","A0080","A0090","A0100","A0110","A0120","A0130","A0140","A0160","A0170","A0180","A0190","A0200","A0210","A0426","A0428"],
 "Non-residential mental / behavioral health":["90791","90792","90832","90833","90834","90836","90837","90838","90846","90847","90853","H0031","H0032","H0034","H0035","H0036","H0037","H0039","H0040","H2010","H2011","H2012","H2013","H2017","H2018","H2019","H2020","H0001","H0004","H0005","H0015","H0018","H0019","H0020","H0047","H0050","H2035","H2036","H2014"],
 "Peer Recovery Services":["H0038","H0025","H0046"],
 "Adult Day Services":["S5100","S5101","S5102","S5105"],
 "Comprehensive Community Support":["H2015","H2016"],
 "Supported Housing":["H0043","H0044"],
 "Home Health Services":["G0151","G0152","G0153","G0155","G0156","G0157","G0158","G0159","G0160","G0161","G0162","G0299","G0300","T1021","T1022","T1030","T1031","S9122","S9123","S9124","T1502","T1503","99500","99501","99502","99503","99504","99505","99506","99507","99509","99510","99511","99512","99600"],
}
TIER={"Personal Care Services / HCBS":1,"ABA / autism therapy":1,"Non-Emergency Medical Transport":1,
 "Non-residential mental / behavioral health":2,"Durable Medical Equipment":2,"Home Health Services":2,
 "Comprehensive Community Support":3,"Supported Housing":3,"Peer Recovery Services":3,"Adult Day Services":3}
NOTE={"ABA / autism therapy":"Adaptive-behavior CPT codes 97151–97158, introduced Jan 2019."}
con.execute("CREATE TEMP TABLE xw(hcpcs VARCHAR, category VARCHAR)")
con.executemany("INSERT INTO xw VALUES (?,?)", [(c,cat) for cat,codes in XW.items() for c in codes])

# categorized claim rows with both geographic attributions
con.execute("""CREATE TEMP TABLE claims AS
  SELECT COALESCE(xw.category,
            CASE WHEN regexp_matches(d.HCPCS_CODE,'^(E[0-9]|K[0-9])') THEN 'Durable Medical Equipment' END) AS cat,
         CAST(substr(d.CLAIM_FROM_MONTH,1,4) AS INT) AS yr,
         b.fips AS prov_fips, COALESCE(s.fips,b.fips) AS poc_fips,
         d.TOTAL_PAID AS paid
  FROM m.dataset d
  LEFT JOIN xw ON d.HCPCS_CODE=xw.hcpcs
  LEFT JOIN npi_fips b ON TRY_CAST(d.BILLING_PROVIDER_NPI_NUM   AS BIGINT)=b.npi
  LEFT JOIN npi_fips s ON TRY_CAST(d.SERVICING_PROVIDER_NPI_NUM AS BIGINT)=s.npi
  WHERE d.CLAIM_FROM_MONTH BETWEEN '2019-01' AND '2023-12'
    AND (xw.category IS NOT NULL OR regexp_matches(d.HCPCS_CODE,'^(E[0-9]|K[0-9])'))""")
print("categorized rows:", con.execute("SELECT COUNT(*) FROM claims").fetchone()[0])

YEARS=list(range(2019,2024))  # 2019-2023: five complete, comparable calendar years
cov = con.execute("SELECT ROUND(100.0*SUM(CASE WHEN prov_fips IS NOT NULL THEN paid ELSE 0 END)/SUM(paid),1) FROM claims").fetchone()[0]
reattr = con.execute("SELECT ROUND(100.0*SUM(CASE WHEN poc_fips IS DISTINCT FROM prov_fips THEN paid ELSE 0 END)/SUM(paid),1) FROM claims").fetchone()[0]

# national landscape (statewide = all categorized paid, mapped or not)
natl = con.execute("SELECT cat, yr, ROUND(SUM(paid)/1e6,3) p FROM claims GROUP BY 1,2").df()
natl_shift = {r['cat']: r['p'] for _,r in con.execute("""SELECT cat,
   ROUND(100.0*SUM(CASE WHEN poc_fips IS DISTINCT FROM prov_fips THEN paid ELSE 0 END)/NULLIF(SUM(paid),0),1) p
   FROM claims GROUP BY 1""").df().iterrows()}

# state-level series (both attributions)
def agg_state(col):
    return con.execute(f"""SELECT cat, substr({col},1,2) AS st, yr, ROUND(SUM(paid)/1e6,3) p
       FROM claims WHERE {col} IS NOT NULL GROUP BY 1,2,3""").df()
st_prov, st_poc = agg_state("prov_fips"), agg_state("poc_fips")
# county-level series (both attributions)
def agg_cty(col):
    return con.execute(f"""SELECT cat, {col} AS fips, yr, ROUND(SUM(paid)/1e6,4) p
       FROM claims WHERE {col} IS NOT NULL GROUP BY 1,2,3""").df()
cty_prov, cty_poc = agg_cty("prov_fips"), agg_cty("poc_fips")
# per-state poc shift per category
st_shift = con.execute("""SELECT substr(prov_fips,1,2) st, cat,
   ROUND(100.0*SUM(CASE WHEN poc_fips IS DISTINCT FROM prov_fips THEN paid ELSE 0 END)/NULLIF(SUM(paid),0),1) p
   FROM claims WHERE prov_fips IS NOT NULL GROUP BY 1,2""").df()

# reference: names + population
state_names = {g['id']: g['properties']['name'] for g in json.load(open(f"{ROOT}/data/us-counties.topo.json"))['objects']['states']['geometries']}
cty_names = {r['fips']: r['cn'] for _,r in con.execute("SELECT DISTINCT county_fips AS fips, county_name AS cn FROM zc").df().iterrows()}
cty_pop = {r['fips']: int(r['population_2024']) for _,r in con.execute("SELECT fips, population_2024 FROM pop").df().iterrows()}
st_pop = {}
for f,p in cty_pop.items(): st_pop[f[:2]] = st_pop.get(f[:2],0)+p

ALLCATS = list(TIER.keys())
def series_map(df, key):  # df: cat, <unit>, yr, p  -> {cat:{unit:{key:{yr:val}}}}
    out={}
    for (cat,unit),g in df.groupby([df.columns[0], df.columns[1]]):
        yrs={int(r[2]):r[3] for r in g.itertuples(index=False)}
        out.setdefault(cat,{}).setdefault(unit,{})[key]={str(y):round(float(yrs.get(y,0.0)),4) for y in YEARS}
    return out

# merge prov+poc into one nested structure
def merge_series(prov_df, poc_df, ndec):
    sp=series_map(prov_df,"prov"); pp=series_map(poc_df,"poc"); out={}
    for cat in set(sp)|set(pp):
        out[cat]={}
        units=set(sp.get(cat,{}))|set(pp.get(cat,{}))
        for u in units:
            node={}
            node["prov"]=sp.get(cat,{}).get(u,{}).get("prov",{str(y):0.0 for y in YEARS})
            node["poc"] =pp.get(cat,{}).get(u,{}).get("poc",{str(y):0.0 for y in YEARS})
            out[cat][u]=node
    return out

series_state = merge_series(st_prov, st_poc, 3)

# national landscape categories
natlp = natl.pivot_table(index='cat',columns='yr',values='p',fill_value=0)
def landscape(pivot, shift_lookup):
    cats=[]
    for cat in sorted(TIER, key=lambda c:(TIER[c], -(pivot.loc[c,2023] if c in pivot.index else 0))):
        row = pivot.loc[cat] if cat in pivot.index else pd.Series({y:0 for y in YEARS})
        sw = {str(y):round(float(row.get(y,0)),2) for y in YEARS}
        b19,b23 = row.get(2019,0), row.get(2023,0)
        cats.append({"name":cat,"tier":TIER[cat],"note":NOTE.get(cat,""),"statewide":sw,
          "mult_19_23":round(b23/b19,2) if b19>0 else None,
          "cagr_19_23":round(((b23/b19)**0.25-1)*100,1) if b19>0 else None,
          "level_2023":round(float(b23),1),
          "poc_shift_pct":shift_lookup.get(cat)})
    return cats

states_meta = {st: {"name":state_names.get(st, st), "pop":st_pop.get(st,0)} for st in sorted(set(st_prov.st))}
national = {
  "meta":{"level":"national","source":"HHS OpenData medicaid-provider-spending (national)",
    "metric":"Medicaid paid amount ($M), summed TOTAL_PAID","window":"2019-2023 (five complete calendar years)",
    "years":YEARS,"county_coverage_pct":cov,"poc_reattr_pct":reattr,
    "caveats":[
      "Window restricted to 2019-2023: the five complete, comparable calendar years. The source also covers 2018 and 2024, but 2024's final months were still in claims runout at extract time, and 2018 predates the Jan-2019 ABA CPT codes (a $0 baseline for that category). Growth = 2019->2023.",
      "Geography = provider ZIP (NPPES) -> county FIPS; %.0f%% of categorized paid maps to a county/state (institutional billers with non-residential ZIPs are unmapped)." % cov,
      "Billing attribution = billing-provider county; point-of-care = servicing-provider county (else billing). The dataset has NO patient address, so point-of-care is the closest patient-proximate lens, still provider-based.",
      "Switching billing->point-of-care moves %.1f%% of categorized spend to a different county; concentrated in clinician-delivered, agency-billed services." % reattr]},
  "states":states_meta, "categories":landscape(natlp, natl_shift), "series_state":series_state}
json.dump(national, open(f"{ROOT}/data/national.json","w"))

# per-state county files
sc_prov = merge_series(cty_prov, cty_poc, 4)  # nested cat->fips->{prov,poc}
# group counties by state
states_present = sorted({f[:2] for cat in sc_prov for f in sc_prov[cat]})
shift_by_state = {}
for _,r in st_shift.iterrows(): shift_by_state.setdefault(r['st'],{})[r['cat']]=r['p']
nfiles=0
for st in states_present:
    fileseries={}; counties={}
    for cat in sc_prov:
        for fips,node in sc_prov[cat].items():
            if fips[:2]!=st: continue
            fileseries.setdefault(cat,{})[fips]=node
            if fips not in counties:
                counties[fips]={"name":cty_names.get(fips,fips)}
                if fips in cty_pop: counties[fips]["pop"]=cty_pop[fips]
    obj={"fips":st,"name":state_names.get(st,st),"pop":st_pop.get(st,0),
         "counties":counties,"poc_shift":shift_by_state.get(st,{}),"series":fileseries}
    json.dump(obj, open(f"{ROOT}/data/states/{st}.json","w")); nfiles+=1

print(f"national county coverage: {cov}% | poc re-attribution: {reattr}%")
print(f"states: {len(states_meta)} | per-state files: {nfiles}")
print("national.json: %.0f KB" % (os.path.getsize(f'{ROOT}/data/national.json')/1024))
print("\nNATIONAL landscape (2019 -> 2023):")
for c in national["categories"]:
    print(f"  T{c['tier']} {c['name'][:42]:42} {c['statewide']['2019']:>9} -> {c['statewide']['2023']:>9}  {c['mult_19_23']}x")
