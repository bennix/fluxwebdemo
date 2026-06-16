import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, "src/client/flux.client.js");
const outPath = path.join(root, "public/flux.js");

const source = fs.readFileSync(sourcePath, "utf8");

function readString(code, start) {
  const quote = code[start];
  let i = start + 1;
  let raw = quote;
  let value = "";
  while (i < code.length) {
    const ch = code[i];
    raw += ch;
    if (ch === "\\") {
      raw += code[i + 1] || "";
      value += JSON.parse(`"${code.slice(i, i + 2).replace(/"/g, '\\"')}"`);
      i += 2;
      continue;
    }
    if (ch === quote) return { raw, value, end: i + 1 };
    value += ch;
    i += 1;
  }
  throw new Error(`Unterminated string at ${start}`);
}

function stripComments(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < code.length) {
        out += code[i];
        if (code[i] === "\\") {
          i += 1;
          out += code[i] || "";
        } else if (code[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function compactWhitespace(code) {
  let out = "";
  let i = 0;
  let inString = null;
  while (i < code.length) {
    const ch = code[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        i += 1;
        out += code[i] || "";
      } else if (ch === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      const prev = out[out.length - 1] || "";
      let j = i + 1;
      while (j < code.length && /\s/.test(code[j])) j += 1;
      const next = code[j] || "";
      if (/[$\w]/.test(prev) && /[$\w]/.test(next)) out += " ";
      i = j;
      continue;
    }
    if ("{}[]();,:+-*/%=<>!&|?".includes(ch) && out.endsWith(" ")) out = out.slice(0, -1);
    out += ch;
    i += 1;
  }
  return out.trim();
}

function encodeString(value, index) {
  const key = 53 + (index % 151);
  const bytes = Buffer.from(value, "utf8").map((byte) => byte ^ key);
  return { key, data: bytes.toString("base64") };
}

function obfuscateStrings(code) {
  const strings = [];
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch !== "'" && ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }
    const parsed = readString(code, i);
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    let j = parsed.end;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    const isObjectKey = code[j] === ":" && (code[k] === "{" || code[k] === ",");
    if (parsed.value === "use strict" || isObjectKey) {
      out += parsed.raw;
    } else {
      const index = strings.length;
      strings.push(encodeString(parsed.value, index));
      out += `_0xs(${index})`;
    }
    i = parsed.end;
  }
  const table = JSON.stringify(strings);
  const decoder =
    `const _0xq=${table};const _0xs=i=>{const e=_0xq[i],b=atob(e.data);let o="";for(let j=0;j<b.length;j++)o+=String.fromCharCode(b.charCodeAt(j)^e.key);return decodeURIComponent(escape(o))};`;
  return out.replace("'use strict';", `'use strict';${decoder}`);
}

const stripped = stripComments(source);
const obfuscated = compactWhitespace(obfuscateStrings(stripped));
fs.writeFileSync(outPath, obfuscated + "\n");
console.log(`wrote ${path.relative(root, outPath)} (${Buffer.byteLength(obfuscated)} bytes)`);
