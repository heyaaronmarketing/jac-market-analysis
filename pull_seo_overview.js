#!/usr/bin/env node
/**
 * pull_seo_overview.js — surgical DFS pull for the SEO overview.
 * Grabs search volumes for the money cities revealed by the 365-day jobs CSV
 * that weren't in the original cities-geo.json config, plus local-pack SERPs
 * for the top revenue cities so we can see who JAC is really competing with
 * where the money actually lives.
 *
 * Env: DFS_LOGIN, DFS_PASSWORD. Cached in data/raw/.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DFS = "https://api.dataforseo.com/v3";
const LOGIN = process.env.DFS_LOGIN;
const PASSWORD = process.env.DFS_PASSWORD;
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RAW = path.join(ROOT, "data", "raw");
fs.mkdirSync(RAW, { recursive: true });
if (!LOGIN || !PASSWORD) { console.error("export DFS_LOGIN and DFS_PASSWORD"); process.exit(1); }

// Money cities from the 365-day CSV that aren't in cities-geo.json already
const NEW_CITIES = [
  "The Villages", "Ormond Beach", "Fruitland Park", "Edgewater",
  "Longwood", "Davenport", "Lake Mary", "Melbourne",
  "Deltona", "Groveland", "Belle Isle", "Lake Wales",
  "Oldsmar", "Valrico",
];

// Top revenue cities that don't already have local-pack SERPs (Orlando + Tampa
// are already covered by lsa-data.json)
const SERP_CITIES = [
  "Kissimmee", "Winter Park", "The Villages", "Sanford",
  "Ormond Beach", "Fruitland Park", "Melbourne", "Lake Mary",
];

const CORE = [
  "roof repair","roof repair near me","roofer near me","roofing contractor",
  "roof replacement","new roof","roof installation","roof leak repair",
  "roof leak","storm damage roof repair","hail damage roof","emergency roof repair",
  "shingle roof repair","tile roof repair","roof inspection",
];

let cost = 0;
function auth() { return "Basic " + Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64"); }
function cacheKey(ep, body) {
  return path.join(RAW, crypto.createHash("sha1").update(ep+JSON.stringify(body)).digest("hex").slice(0,16) + ".json");
}
async function call(ep, body, label) {
  const cf = cacheKey(ep, body);
  if (fs.existsSync(cf)) { console.log(`  [cache] ${label}`); return JSON.parse(fs.readFileSync(cf, "utf8")); }
  const r = await fetch(DFS+ep, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:auth() }, body: JSON.stringify(body) });
  const j = await r.json();
  fs.writeFileSync(cf, JSON.stringify(j, null, 2));
  cost += j.cost || 0;
  console.log(`  [live]  ${label}  status=${j.status_code}  $${(j.cost||0).toFixed(4)}`);
  if (j.status_code !== 20000) console.warn(`      WARN: ${j.status_message}`);
  return j;
}

function nameVariants(name) {
  const out = new Set([name]);
  if (/^St\b/i.test(name)) { out.add(name.replace(/^St\b/i, "Saint")); out.add(name.replace(/^St\b/i, "St.")); }
  return [...out];
}
async function pullSearchVolume(city) {
  for (const variant of nameVariants(city)) {
    const body = [{ location_name: `${variant},Florida,United States`, language_code: "en", keywords: CORE, search_partners: false }];
    const j = await call("/keywords_data/google_ads/search_volume/live", body, `vol ${variant}`);
    const t = j.tasks?.[0];
    if (t?.status_code === 20000 && t?.result) return { city, location_name: `${variant},Florida,United States`, items: t.result };
  }
  return { city, location_name: null, items: [] };
}
async function pullLocalPack(query, cityLoc) {
  const body = [{ keyword: query, location_name: cityLoc, language_code: "en", device: "desktop", depth: 20 }];
  const j = await call("/serp/google/organic/live/advanced", body, `serp ${query} @ ${cityLoc}`);
  const items = j.tasks?.[0]?.result?.[0]?.items || [];
  const lp = items.find(i => i.type === "local_pack");
  const rows = lp?.items || [];
  return rows.slice(0,3).map((it,i)=>({
    rank:i+1, name:it.title||it.name||null, rating:it.rating?.value ?? null,
    review_count:it.rating?.votes_count ?? it.rating_reviews_count ?? null,
  }));
}

async function main() {
  const out = { generated_at: new Date().toISOString(), volumes: {}, local_packs: {}, total_cost_usd: 0 };
  console.log(`=== search volumes for ${NEW_CITIES.length} new revenue cities ===`);
  for (const c of NEW_CITIES) {
    out.volumes[c] = await pullSearchVolume(c);
  }
  console.log(`\n=== local-pack SERPs for ${SERP_CITIES.length} money cities (roof repair {city}) ===`);
  for (const c of SERP_CITIES) {
    const loc = out.volumes[c]?.location_name || `${c},Florida,United States`;
    out.local_packs[c] = await pullLocalPack(`roof repair ${c}`, loc);
  }
  out.total_cost_usd = +cost.toFixed(4);
  const outPath = path.join(ROOT, "data", "seo-overview-pull.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}   total DFS cost: $${cost.toFixed(4)}`);

  // Quick summary
  console.log(`\n=== summary: total core-term volume per city ===`);
  for (const [c, d] of Object.entries(out.volumes)) {
    const vol = (d.items || []).reduce((a,it)=>a+(it.search_volume||0),0);
    const cpc = (d.items || []).map(it=>it.cpc).filter(n=>typeof n==='number');
    const avgCpc = cpc.length ? (cpc.reduce((a,b)=>a+b,0)/cpc.length).toFixed(2) : "—";
    console.log(`  ${c.padEnd(20)} vol=${String(vol).padStart(5)}/mo  avg CPC=$${avgCpc}`);
  }
  console.log(`\n=== local-pack top-3 for "roof repair {city}" ===`);
  for (const [c, rows] of Object.entries(out.local_packs)) {
    console.log(`  ${c}:`);
    if (!rows.length) console.log(`    (no local pack returned)`);
    for (const r of rows) console.log(`    #${r.rank} ${r.name} (${r.review_count} reviews @ ${r.rating}★)`);
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
