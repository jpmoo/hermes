#!/usr/bin/env node
/**
 * Re-embed all notes with the current Ollama input rules (e.g. search_document: prefix).
 * Run from server/:  npm run reembed
 * Requires: DATABASE_URL, Ollama up, HERMES_EMBED_NOMIC_PREFIXES=1 if using Nomic task prefixes.
 */
import pool from '../src/db/pool.js';
import { embed, inputForDocument, useNomicTaskPrefixes } from '../src/services/ollama.js';

async function main() {
  const r = await pool.query('SELECT id, content FROM notes ORDER BY id');
  const total = r.rows.length;
  console.log(`Re-embedding ${total} notes (Nomic task prefixes: ${useNomicTaskPrefixes()})`);
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (let i = 0; i < r.rows.length; i++) {
    const { id, content } = r.rows[i];
    const input = inputForDocument(content);
    if (!input) {
      skip++;
      continue;
    }
    const vec = await embed(input);
    if (!vec) {
      console.warn(`  skip id=${id} (embed failed)`);
      fail++;
      continue;
    }
    const vecStr = `[${vec.join(',')}]`;
    await pool.query('UPDATE notes SET embedding = $1::vector WHERE id = $2', [vecStr, id]);
    ok++;
    if ((i + 1) % 50 === 0 || i === r.rows.length - 1) {
      console.log(`  ... ${i + 1}/${total}`);
    }
    await new Promise((r2) => setTimeout(r2, 30));
  }
  console.log(`Done. embedded=${ok} empty_skip=${skip} failed=${fail}`);
  await pool.end();
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
