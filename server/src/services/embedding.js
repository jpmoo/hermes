import pool from '../db/pool.js';
import { embed, inputForDocument } from './ollama.js';

export async function embedNote(noteId, content) {
  const input = inputForDocument(content);
  if (!input) return;
  const vec = await embed(input);
  if (!vec) return;
  const vecStr = `[${vec.join(',')}]`;
  await pool.query(
    'UPDATE notes SET embedding = $1::vector WHERE id = $2',
    [vecStr, noteId]
  );
}
