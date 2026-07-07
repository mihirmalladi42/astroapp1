import { writeFile } from "node:fs/promises";

const SIMBAD_TAP = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync";
const CALDWELL_RAW = "https://en.wikipedia.org/wiki/Caldwell_catalogue?action=raw";
const IAU_STAR_NAMES = "https://exopla.net/star-names/modern-iau-star-names/";
const CDS_SESAME = "https://cds.unistra.fr/cgi-bin/Sesame/-oxp/SNV";
const CDS_NGC2000 = "https://cdsarc.cds.unistra.fr/ftp/VII/118/ngc2000.dat";

const SOURCES = {
  simbad: {
    name: "SIMBAD TAP",
    url: SIMBAD_TAP,
    note: "Modern object coordinates from CDS/SIMBAD basic table; RA/Dec in decimal degrees.",
  },
  sesame: {
    name: "CDS Sesame",
    url: CDS_SESAME,
    note: "Fallback resolver for names that are not simple NGC/IC/Messier identifiers.",
  },
  caldwell: {
    name: "Caldwell catalogue mapping",
    url: CALDWELL_RAW,
    note: "Used only to map Caldwell numbers to underlying object designations/names.",
  },
  ngc2000: {
    name: "CDS/VizieR VII/118 NGC 2000.0",
    url: CDS_NGC2000,
    note: "Fallback for NGC/IC entries not returned as exact SIMBAD identifiers; positions are from the NGC 2000.0 catalog.",
  },
  iauStars: {
    name: "IAU-Catalog of Star Names",
    url: IAU_STAR_NAMES,
    note: "IAU WGSN star-name table hosted at exopla.net; includes RA/Dec columns.",
  },
};

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Sky Lens catalog generator",
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }

  return response.text();
}

function parseNgc2000(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 25) continue;
    const rawName = line.slice(0, 5).trim();
    if (!rawName) continue;

    const isIc = /^I/i.test(rawName);
    const number = Number(rawName.replace(/^I/i, "").trim());
    if (!Number.isInteger(number)) continue;

    const rah = Number(line.slice(10, 12).trim());
    const ram = Number(line.slice(13, 17).trim());
    const sign = line.slice(19, 20) === "-" ? -1 : 1;
    const ded = Number(line.slice(20, 22).trim());
    const dem = Number(line.slice(23, 25).trim());
    if (![rah, ram, ded, dem].every(Number.isFinite)) continue;

    const id = `${isIc ? "IC" : "NGC"} ${number}`;
    map.set(id, {
      id,
      type: line.slice(6, 9).trim(),
      constellation: line.slice(29, 32).trim(),
      ra: round((rah + ram / 60) * 15, 8),
      dec: round(sign * (ded + dem / 60), 8),
    });
  }
  return map;
}

function objectFromNgc2000(row, catalog) {
  return {
    id: row.id,
    name: row.id,
    catalog,
    type: row.type || "",
    ra: row.ra,
    dec: row.dec,
    constellation: row.constellation || "",
    aliases: [row.id],
    source: ["ngc2000"],
  };
}

async function simbadTap(query, maxrec = 100000) {
  const url = new URL(SIMBAD_TAP);
  url.searchParams.set("request", "doQuery");
  url.searchParams.set("lang", "adql");
  url.searchParams.set("format", "tsv");
  url.searchParams.set("MAXREC", String(maxrec));
  url.searchParams.set("query", query);
  return parseTsv(await fetchText(url));
}

function parseTsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split("\t");
  return lines
    .filter(Boolean)
    .map((line) => {
      const cells = splitTsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, unquote(cells[index] || "")]));
    });
}

function splitTsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "\t" && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function unquote(value) {
  return value.replace(/^"|"$/g, "").replace(/""/g, "\"").trim();
}

function normalizeCatalogId(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseCatalogNumber(id, prefix, max) {
  const match = normalizeCatalogId(id).match(new RegExp(`^${prefix} (\\d{1,4})$`, "i"));
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1 || number > max) return null;
  return number;
}

function cleanName(value) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, "")
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/''+/g, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&#215;/g, "x")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function objectFromSimbad(row, id, catalog, extra = {}) {
  const ra = Number(row.ra);
  const dec = Number(row.dec);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;

  return {
    id,
    name: extra.name || id,
    catalog,
    type: row.otype_txt || extra.type || "",
    ra: round(ra, 8),
    dec: round(dec, 8),
    aliases: unique([id, normalizeCatalogId(row.main_id || ""), ...(extra.aliases || [])]),
    source: unique(["simbad", ...(extra.source || [])]),
  };
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildSimbadMaps(rows) {
  const maps = {
    NGC: new Map(),
    IC: new Map(),
    M: new Map(),
  };

  for (const row of rows) {
    const id = normalizeCatalogId(row.id);
    const ngc = parseCatalogNumber(id, "NGC", 7840);
    if (ngc && !maps.NGC.has(ngc)) maps.NGC.set(ngc, row);

    const ic = parseCatalogNumber(id, "IC", 5386);
    if (ic && !maps.IC.has(ic)) maps.IC.set(ic, row);

    const messier = parseCatalogNumber(id, "M", 110);
    if (messier && !maps.M.has(messier)) maps.M.set(messier, row);
  }

  return maps;
}

function parseObjectDesignations(raw) {
  const designations = [];
  const links = raw.match(/\[\[[^\]]+\]\]/g) || [];

  for (const link of links) {
    const inner = link.slice(2, -2);
    const parts = inner.split("|");
    const candidates = [parts[0], parts[1] || ""];

    for (const candidate of candidates) {
      const catalogMatches = candidate.matchAll(/\b(NGC|IC)\s*(\d{1,4})\b/gi);
      for (const match of catalogMatches) {
        designations.push(`${match[1].toUpperCase()} ${Number(match[2])}`);
      }

      const sh2 = candidate.match(/\bSh2-(\d+)\b/i);
      if (sh2) designations.push(`Sh2-${sh2[1]}`);

      const mel = candidate.match(/\bMel\s*25\b/i);
      if (mel) designations.push("Mel 25");
    }
  }

  return unique(designations);
}

function parseCaldwell(raw) {
  const blocks = raw.split(/\n\|- /);
  const rows = [];

  for (const block of blocks) {
    const idMatch = block.match(/\{\{hs\|\d+\}\}C(\d{1,3})/);
    if (!idMatch) continue;

    const id = `C${Number(idMatch[1])}`;
    const designations = parseObjectDesignations(block);
    const commonMatch = block.match(/\|\s*''([^|\n]+?)''\s*\n/);
    const common = commonMatch ? cleanName(commonMatch[1]) : "";

    rows.push({
      id,
      name: common || `Caldwell ${Number(idMatch[1])}`,
      designations,
      fallbackName: id === "C99" ? "Coalsack Nebula" : common,
    });
  }

  rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return rows;
}

function averageCoordinates(records) {
  if (records.length === 1) return { ra: records[0].ra, dec: records[0].dec };

  let x = 0;
  let y = 0;
  let z = 0;
  for (const record of records) {
    const ra = (record.ra * Math.PI) / 180;
    const dec = (record.dec * Math.PI) / 180;
    x += Math.cos(dec) * Math.cos(ra);
    y += Math.cos(dec) * Math.sin(ra);
    z += Math.sin(dec);
  }

  const ra = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const hyp = Math.hypot(x, y);
  const dec = (Math.atan2(z, hyp) * 180) / Math.PI;
  return { ra: round(ra, 8), dec: round(dec, 8) };
}

async function sesameResolve(name) {
  if (!name) return null;
  const url = `${CDS_SESAME}?${encodeURIComponent(name)}`;
  const xml = await fetchText(url);
  const ra = Number((xml.match(/<jradeg>([^<]+)<\/jradeg>/) || [])[1]);
  const dec = Number((xml.match(/<jdedeg>([^<]+)<\/jdedeg>/) || [])[1]);
  const oname = (xml.match(/<oname>([^<]+)<\/oname>/) || [])[1];
  const otype = (xml.match(/<otype>([^<]+)<\/otype>/) || [])[1];
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  return {
    id: name,
    name,
    catalog: "resolved",
    type: otype || "",
    ra: round(ra, 8),
    dec: round(dec, 8),
    aliases: unique([name, oname && decodeHtml(oname)]),
    source: ["sesame"],
  };
}

function parseIauStarRows(html) {
  const rows = [];
  const rowMatches = html.match(/<tr id="table_2_row_\d+"[\s\S]*?<\/tr>/g) || [];

  for (const rowHtml of rowMatches) {
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => cleanName(match[1]));
    if (cells.length < 16) continue;

    const properName = cells[0];
    const designation = cells[2];
    const hip = cells[3];
    const bayer = cells[4];
    const simbadSpelling = cells[5];
    const constellation = cells[6];
    const ra = Number(cells[13]);
    const dec = Number(cells[14]);
    const mag = Number(cells[15]);

    if (!properName || !Number.isFinite(ra) || !Number.isFinite(dec)) continue;

    rows.push({
      id: properName,
      name: properName,
      catalog: "star",
      type: "Star",
      ra: round(ra, 8),
      dec: round(dec, 8),
      mag: Number.isFinite(mag) ? mag : null,
      constellation,
      aliases: unique([properName, simbadSpelling, designation, hip && `HIP ${hip}`, bayer]),
      source: ["iauStars"],
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function catalogLookup(designation, maps, ngc2000Map) {
  const ngc = designation.match(/^NGC (\d+)$/i);
  if (ngc) {
    const row = maps.NGC.get(Number(ngc[1]));
    if (row) return objectFromSimbad(row, `NGC ${Number(ngc[1])}`, "ngc");
    const fallback = ngc2000Map.get(`NGC ${Number(ngc[1])}`);
    return fallback && objectFromNgc2000(fallback, "ngc");
  }

  const ic = designation.match(/^IC (\d+)$/i);
  if (ic) {
    const row = maps.IC.get(Number(ic[1]));
    if (row) return objectFromSimbad(row, `IC ${Number(ic[1])}`, "ic");
    const fallback = ngc2000Map.get(`IC ${Number(ic[1])}`);
    return fallback && objectFromNgc2000(fallback, "ic");
  }

  return null;
}

async function buildCatalog() {
  const query = `
SELECT id, main_id, ra, dec, otype_txt
FROM ident JOIN basic ON ident.oidref = basic.oid
WHERE id LIKE 'NGC %' OR id LIKE 'IC %' OR id LIKE 'M %'
`;
  const simbadRows = await simbadTap(query);
  const maps = buildSimbadMaps(simbadRows);
  const ngc2000Map = parseNgc2000(await fetchText(CDS_NGC2000));

  const objects = [];

  for (let number = 1; number <= 7840; number += 1) {
    const row = maps.NGC.get(number);
    if (row) {
      objects.push(objectFromSimbad(row, `NGC ${number}`, "ngc"));
      continue;
    }
    const fallback = ngc2000Map.get(`NGC ${number}`);
    if (fallback) objects.push(objectFromNgc2000(fallback, "ngc"));
  }

  for (let number = 1; number <= 110; number += 1) {
    const row = maps.M.get(number);
    if (row) {
      objects.push(objectFromSimbad(row, `M${number}`, "messier", { aliases: [`Messier ${number}`] }));
      continue;
    }

    const resolved = await sesameResolve(`M ${number}`);
    if (resolved) {
      objects.push({
        ...resolved,
        id: `M${number}`,
        name: `Messier ${number}`,
        catalog: "messier",
        aliases: unique([`M${number}`, `M ${number}`, `Messier ${number}`, ...resolved.aliases]),
      });
    }
  }

  const caldwellRows = parseCaldwell(await fetchText(CALDWELL_RAW));
  for (const row of caldwellRows) {
    const coordinateRecords = [];
    const aliases = [`Caldwell ${Number(row.id.slice(1))}`, row.id, ...row.designations];
    const source = ["caldwell"];

    for (const designation of row.designations) {
      const record = catalogLookup(designation, maps, ngc2000Map);
      if (record) {
        coordinateRecords.push(record);
        source.push("simbad");
      } else if (/^(Sh2-|Mel )/i.test(designation)) {
        const resolved = await sesameResolve(designation);
        if (resolved) {
          coordinateRecords.push(resolved);
          source.push("sesame");
        }
      }
    }

    if (coordinateRecords.length === 0 && row.fallbackName) {
      const resolved = await sesameResolve(row.fallbackName);
      if (resolved) {
        coordinateRecords.push(resolved);
        source.push("sesame");
      }
    }

    if (coordinateRecords.length === 0) continue;

    const coords = averageCoordinates(coordinateRecords);
    objects.push({
      id: row.id,
      name: row.name,
      catalog: "caldwell",
      type: coordinateRecords[0].type || "",
      ra: coords.ra,
      dec: coords.dec,
      aliases: unique(aliases),
      source: unique(source),
    });
  }

  const stars = parseIauStarRows(await fetchText(IAU_STAR_NAMES));
  objects.push(...stars);

  const seen = new Set();
  const deduped = objects.filter((object) => {
    if (!object || seen.has(object.id)) return false;
    seen.add(object.id);
    return true;
  });

  deduped.sort((a, b) => {
    const catalogOrder = { ngc: 0, messier: 1, caldwell: 2, star: 3, resolved: 4, ic: 5 };
    const catalogDelta = (catalogOrder[a.catalog] ?? 99) - (catalogOrder[b.catalog] ?? 99);
    if (catalogDelta !== 0) return catalogDelta;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  return {
    generatedAt: new Date().toISOString(),
    coordinateFrame: "ICRS/J2000 decimal degrees unless noted by source",
    sources: SOURCES,
    counts: {
      total: deduped.length,
      ngc: deduped.filter((object) => object.catalog === "ngc").length,
      messier: deduped.filter((object) => object.catalog === "messier").length,
      caldwell: deduped.filter((object) => object.catalog === "caldwell").length,
      stars: deduped.filter((object) => object.catalog === "star").length,
    },
    objects: deduped,
  };
}

const catalog = await buildCatalog();
const js = `// Generated by scripts/generate-catalog.mjs. Do not edit by hand.\n` +
  `window.ASTRO_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`;

await writeFile(new URL("../catalog.js", import.meta.url), js);
console.log(`Wrote catalog.js with ${catalog.counts.total} objects`);
console.log(JSON.stringify(catalog.counts, null, 2));
