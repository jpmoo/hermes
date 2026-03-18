#!/usr/bin/env bash
# Hermes server health: Ollama + embedding model + PostgreSQL embedding columns.
# Run on the machine where Hermes and Ollama run (e.g. home-server).
#
# Usage:
#   cd /path/to/hermes/server && ./scripts/check-hermes-embeddings.sh
#   # or: bash server/scripts/check-hermes-embeddings.sh
#
# Requires: curl, jq (optional but recommended), psql (postgresql-client)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVER_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
  echo "== Loaded $SERVER_DIR/.env"
else
  echo "== Warning: no .env in $SERVER_DIR — using defaults / existing env only"
fi

OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_URL="${OLLAMA_URL%/}"
OLLAMA_EMBED_MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"

echo ""
echo "========== 1) Ollama reachable =========="
if code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 3 "${OLLAMA_URL}/api/tags" 2>/dev/null); then
  if [[ "$code" == "200" ]]; then
    echo "OK  GET ${OLLAMA_URL}/api/tags → HTTP $code"
  else
    echo "BAD GET ${OLLAMA_URL}/api/tags → HTTP $code (expected 200)"
  fi
else
  echo "BAD Cannot reach Ollama at ${OLLAMA_URL} (curl failed — is Ollama running? firewall?)"
fi

echo ""
echo "========== 2) Embed model installed =========="
if tags_json=$(curl -sS --connect-timeout 5 "${OLLAMA_URL}/api/tags" 2>/dev/null); then
  if command -v jq &>/dev/null; then
    if echo "$tags_json" | jq -e --arg m "$OLLAMA_EMBED_MODEL" '.models[] | select(.name == $m or .name == ($m + ":latest"))' &>/dev/null; then
      echo "OK  Model '$OLLAMA_EMBED_MODEL' appears in ollama list (via /api/tags)"
    else
      echo "BAD Model '$OLLAMA_EMBED_MODEL' not found in /api/tags"
      echo "    Fix:  ollama pull $OLLAMA_EMBED_MODEL"
      echo "    Models present (names):"
      echo "$tags_json" | jq -r '.models[].name' 2>/dev/null | head -20 || echo "$tags_json" | head -c 400
    fi
  else
    if echo "$tags_json" | grep -qF "$OLLAMA_EMBED_MODEL"; then
      echo "OK  Model name '$OLLAMA_EMBED_MODEL' appears in /api/tags (install jq for stricter check)"
    else
      echo "??  jq not installed — grep check inconclusive. Install jq or run: ollama list"
    fi
  fi
else
  echo "BAD Could not fetch /api/tags"
fi

echo ""
echo "========== 3) Live embed request =========="
embed_resp=$(curl -sS --connect-timeout 15 "${OLLAMA_URL}/api/embed" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${OLLAMA_EMBED_MODEL}\",\"input\":\"hermes health check\"}" 2>/dev/null) || embed_resp=""

if command -v jq &>/dev/null && [[ -n "$embed_resp" ]]; then
  dim=$(echo "$embed_resp" | jq '.embeddings[0] | length' 2>/dev/null)
  if [[ -n "$dim" && "$dim" != "null" && "$dim" -gt 0 ]]; then
    echo "OK  POST /api/embed returned a vector of length $dim"
  else
    err=$(echo "$embed_resp" | jq -r '.error // empty' 2>/dev/null)
    echo "BAD Embed failed or empty embeddings. Response snippet:"
    echo "$embed_resp" | head -c 500
    [[ -n "$err" ]] && echo "    error: $err"
  fi
elif [[ -n "$embed_resp" ]] && echo "$embed_resp" | grep -q "embeddings"; then
  echo "OK  Response contains 'embeddings' (install jq to verify dimensions)"
else
  echo "BAD Embed request failed or invalid response"
  echo "$embed_resp" | head -c 500
fi

echo ""
echo "========== 4) PostgreSQL notes.embedding =========="
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "BAD DATABASE_URL not set — cannot query DB. Set it in server/.env"
  exit 1
fi

if ! command -v psql &>/dev/null; then
  echo "BAD psql not found. Install:  sudo apt install postgresql-client   (or brew install libpq)"
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\pset tuples_only on
SELECT '--- counts ---';
SELECT
  COUNT(*)::text AS total_notes,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS notes_with_embedding,
  COUNT(*) FILTER (WHERE embedding IS NULL)::text AS notes_without_embedding,
  ROUND(100.0 * COUNT(*) FILTER (WHERE embedding IS NOT NULL) / NULLIF(COUNT(*), 0), 1)::text || '%' AS pct_with_embedding
FROM notes;

SELECT '--- sample notes still missing embedding (up to 5) ---';
SELECT id::text, LEFT(content, 60) AS content_preview, updated_at::text
FROM notes
WHERE embedding IS NULL
ORDER BY updated_at DESC
LIMIT 5;

SELECT '--- vector dimension (from first row that has embedding) ---';
SELECT vector_dims(embedding)::text AS embedding_dimensions
FROM notes
WHERE embedding IS NOT NULL
LIMIT 1;
SQL

echo ""
echo "========== Summary =========="
echo "Hermes writes embeddings only when Ollama embed succeeds (create/update note)."
echo "Notes with NULL embedding never appear in semantic search."
echo "Re-save a note in the app to retry embedding, or fix Ollama then touch notes."
echo "Text search (no embeddings): GET /api/notes/search-content?q=..."
