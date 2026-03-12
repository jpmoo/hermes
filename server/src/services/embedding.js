import pool from '../db/pool.js';
import { embed } from './ollama.js';

export async function embedNote(noteId, content) {
  const vec = await embed(content);
  if (!vec) return;
  const vecStr = `[${vec.join(',')}]`;
  await pool.query(
    'UPDATE notes SET embedding = $1::vector WHERE id = $2',
    [vecStr, noteId]
  );
}
