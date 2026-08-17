// Soi cấu trúc thật của một spreadsheet: tabs, tables, values, format.
//   node scripts/inspect-sheet.mjs <spreadsheetId>
import { chromium } from "playwright";

const ID = process.argv[2];
if (!ID) throw new Error("Thiếu spreadsheetId");
const EXT_ID = "bbhcmfeedghfopbijnbjnhdfenfdinli";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto(`chrome-extension://${EXT_ID}/options.html`);
await page.waitForTimeout(800);
const token = await page.evaluate(
  () =>
    new Promise((res, rej) =>
      chrome.identity.getAuthToken({ interactive: false }, (t) =>
        chrome.runtime.lastError || !t ? rej(new Error(chrome.runtime.lastError?.message ?? "no token")) : res(t),
      ),
    ),
);
await page.close();
await browser.close();

const get = async (path) => {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

const meta = await get(
  `${ID}?fields=properties.title,sheets(properties(sheetId,title,index,gridProperties),tables,bandedRanges,conditionalFormats,basicFilter)`,
);
console.log("Spreadsheet:", meta.properties.title);
for (const s of meta.sheets) {
  const p = s.properties;
  console.log(`\n── tab "${p.title}" (sheetId=${p.sheetId}, index=${p.index})`);
  console.log("   grid:", JSON.stringify(p.gridProperties));
  console.log("   tables:", JSON.stringify(s.tables ?? null));
  console.log("   bandedRanges:", (s.bandedRanges ?? []).length);
  console.log("   conditionalFormats:", (s.conditionalFormats ?? []).length);
  console.log("   basicFilter:", s.basicFilter ? "có" : "không");
}

const first = meta.sheets[0].properties.title;
const vals = await get(`${ID}/values/${encodeURIComponent(`${first}!A1:Z12`)}`);
console.log(`\n── values ${first}!A1:Z12`);
console.log(JSON.stringify(vals.values ?? [], null, 1));
