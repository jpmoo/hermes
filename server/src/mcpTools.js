/**
 * Shared Hermes MCP tool definitions and call handler (stdio + Streamable HTTP).
 */

const ATTACH_FILES_SCHEMA = {
  type: 'object',
  properties: {
    note_id: {
      type: 'string',
      description: 'UUID of the target note (returned by hermes_create_note as id, or from search/thread).',
    },
    files: {
      type: 'array',
      description:
        'One object per file. Required: base64 (standard base64 of raw file bytes) or data (same). Optional: filename, mime_type. Max 20 files.',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          mime_type: { type: 'string' },
          base64: { type: 'string', description: 'File contents as base64 string' },
          data: { type: 'string', description: 'Alias for base64' },
        },
      },
    },
  },
  required: ['note_id', 'files'],
};

export const TOOL_DEFS = [
  {
    name: 'hermes_create_note',
    description:
      'Create a root note or a reply (set parent_id). For LARGE images/files: create text-only, then upload via HTTP POST /api/notes/{id}/attachments (multipart field files) with JWT—not base64 in MCP. Optional small attachments: attachments/files array with base64 per item.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note body text' },
        parent_id: { type: 'string', description: 'If set, this note is a reply under that note id' },
        external_anchor: {
          type: 'string',
          description:
            'Optional free-text link to something outside Hermes (e.g. Jira URL, ticket id, Google Doc id). Stored on the note; returned in API/thread JSON. Web app does not show a dedicated field for it yet—use for sync or your own reference.',
        },
        attachments: {
          type: 'array',
          description: 'Optional: upload files in the same call. Each item: { base64 or data, filename?, mime_type? }',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              mime_type: { type: 'string' },
              base64: { type: 'string' },
              data: { type: 'string' },
            },
          },
        },
        files: {
          type: 'array',
          description: 'Same as attachments',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              mime_type: { type: 'string' },
              base64: { type: 'string' },
              data: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'hermes_attach_files',
    description:
      'Attach files via base64 in JSON—OK for small files; LARGE uploads are slow (MCP JSON bloat). Prefer: POST /api/notes/{note_id}/attachments with multipart form field files + Authorization Bearer JWT. This tool: note_id + files [{ base64, filename?, mime_type? }]. Alias: hermes_add_attachments.',
    inputSchema: ATTACH_FILES_SCHEMA,
  },
  {
    name: 'hermes_get_thread',
    description:
      'Get a note and all replies under it (subtree). Pass the note id of any message in the thread — not only the root. Each note may include an attachments array (uploaded files: id, filename, mime_type, byte_size).',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { type: 'string', description: 'Any note UUID in the branch' },
        note_id: { type: 'string', description: 'Alias for root_id' },
      },
    },
  },
  {
    name: 'hermes_search_semantic',
    description:
      'Semantic similarity search (needs Ollama embeddings). If this fails, use hermes_search_content.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] },
  },
  {
    name: 'hermes_search_content',
    description:
      'Find notes whose body contains the given text (case-insensitive substring). Works without Ollama. Use to locate a note by exact phrase, then hermes_get_thread with that note id for replies.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] },
  },
  { name: 'hermes_search_tags', description: 'Query notes by tag(s).', inputSchema: { type: 'object', properties: { tag_ids: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['and', 'or'] } } } },
  { name: 'hermes_get_queue', description: 'Get pending tag proposals.', inputSchema: { type: 'object', properties: { min_confidence: { type: 'number' } } } },
  { name: 'hermes_approve_tag', description: 'Approve or reject a pending tag.', inputSchema: { type: 'object', properties: { proposal_id: { type: 'string' }, approve: { type: 'boolean' } }, required: ['proposal_id'] } },
  { name: 'hermes_star_note', description: 'Star or unstar a note.', inputSchema: { type: 'object', properties: { note_id: { type: 'string' }, starred: { type: 'boolean' } }, required: ['note_id'] } },
  { name: 'hermes_get_starred', description: 'Get starred roots.' },
  {
    name: 'hermes_get_root_feed',
    description:
      'List all top-level notes (root threads / main feed), newest first. Use for: what notes do I have, show my threads, root-level list.',
  },
  {
    name: 'hermes_add_attachments',
    description: 'Alias for hermes_attach_files — upload base64 files to a note.',
    inputSchema: ATTACH_FILES_SCHEMA,
  },
  {
    name: 'hermes_list_orphan_attachments',
    description:
      'List file blobs whose note was deleted (orphan attachments). Each row: id (blob id for delete), note_id (dead reference), filename, mime_type, byte_size, created_at. Use hermes_delete_orphan_attachment to remove storage.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hermes_delete_orphan_attachment',
    description:
      'Permanently delete one orphan attachment by blob id (from hermes_list_orphan_attachments). Only succeeds if the note no longer exists; cannot delete files still attached to a live note.',
    inputSchema: {
      type: 'object',
      properties: {
        blob_id: { type: 'string', description: 'UUID of the note_file_blobs row (field id from list orphans)' },
        id: { type: 'string', description: 'Alias for blob_id' },
      },
      required: [],
    },
  },
  {
    name: 'hermes_attachment_upload_help',
    description:
      'Returns the exact HTTP multipart upload URL pattern for attachments (POST …/api/notes/{note_id}/attachments, field files, Bearer JWT). Use when the user asks how to upload outside MCP. Explains Claude sandbox cannot reach private servers.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Optional; if set, response includes a filled example URL' },
      },
    },
  },
];

export async function listTools() {
  return {
    tools: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' },
    })),
  };
}

/**
 * @param {{ api: (path: string, options?: RequestInit) => Promise<unknown>, uploadAttachments?: (noteId: string, files: unknown[]) => Promise<unknown> }} ctx
 */
export async function callTool(ctx, req) {
  const { api, uploadAttachments } = ctx;
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'hermes_create_note': {
        const { content, parent_id, external_anchor, attachments, files: filesArg } = args || {};
        const fileList = Array.isArray(attachments) && attachments.length ? attachments : Array.isArray(filesArg) ? filesArg : [];
        const body = await api('/notes', {
          method: 'POST',
          body: JSON.stringify({
            content: content || '',
            parent_id: parent_id || null,
            external_anchor: external_anchor || null,
          }),
        });
        if (fileList.length > 0) {
          if (!uploadAttachments) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ...body,
                      attachment_warning:
                        'Note created but this MCP session cannot upload files here; call hermes_attach_files (or hermes_add_attachments) with this note id.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          try {
            const uploaded = await uploadAttachments(body.id, fileList);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ ...body, attachments_uploaded: uploaded }, null, 2),
                },
              ],
            };
          } catch (uploadErr) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: uploadErr.message,
                      note_created: body,
                      hint: 'Note exists; retry with hermes_attach_files using note id above.',
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_thread': {
        const threadId = args?.root_id || args?.note_id;
        if (!threadId) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'root_id or note_id required' }) }],
            isError: true,
          };
        }
        const body = await api(`/notes/thread/${threadId}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_semantic': {
        const { q, limit } = args || {};
        const body = await api(`/notes/search-semantic?q=${encodeURIComponent(q || '')}&limit=${limit || 20}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_content': {
        const { q, limit } = args || {};
        const body = await api(`/notes/search-content?q=${encodeURIComponent(q || '')}&limit=${limit || 40}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_tags': {
        const { tag_ids, mode } = args || {};
        const ids = Array.isArray(tag_ids) ? tag_ids : (tag_ids || '').toString().split(',').filter(Boolean);
        const body = await api(`/notes/search-by-tags?tagIds=${ids.join(',')}&mode=${mode || 'and'}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_queue': {
        const { min_confidence } = args || {};
        const body = await api(`/queue?minConfidence=${min_confidence ?? 0}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_approve_tag': {
        const { proposal_id, approve } = args || {};
        if (approve) await api(`/queue/${proposal_id}/approve`, { method: 'POST' });
        else await api(`/queue/${proposal_id}/reject`, { method: 'POST' });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
      case 'hermes_star_note': {
        const { note_id, starred } = args || {};
        if (starred) await api(`/notes/${note_id}/star`, { method: 'POST' });
        else await api(`/notes/${note_id}/star`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
      case 'hermes_get_starred': {
        const body = await api('/notes/roots?starred=true');
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_get_root_feed': {
        const body = await api('/notes/roots');
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_attach_files':
      case 'hermes_add_attachments': {
        if (!uploadAttachments) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'File upload is not available on this MCP path (multipart upload missing). Use Streamable HTTP MCP on the Hermes server or stdio MCP with upload support.',
                }),
              },
            ],
            isError: true,
          };
        }
        const { note_id, files } = args || {};
        const list = Array.isArray(files) ? files : [];
        const body = await uploadAttachments(note_id, list);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_list_orphan_attachments': {
        const body = await api('/note-files/orphans');
        const list = Array.isArray(body) ? body : [];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: list.length, orphans: list }, null, 2),
            },
          ],
        };
      }
      case 'hermes_delete_orphan_attachment': {
        const blobId = args?.blob_id || args?.id;
        if (!blobId || !String(blobId).trim()) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'blob_id (or id) required' }) }],
            isError: true,
          };
        }
        await api(`/note-files/orphans/${encodeURIComponent(String(blobId).trim())}`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted: blobId }) }] };
      }
      case 'hermes_attachment_upload_help': {
        const noteId = args?.note_id ? String(args.note_id).trim() : '{note_uuid}';
        const publicBase = (process.env.HERMES_PUBLIC_API_URL || '').replace(/\/$/, '');
        const pathSuffix = `/api/notes/${noteId}/attachments`;
        const payload = {
          method: 'POST',
          path_pattern: '/api/notes/{note_id}/attachments',
          multipart_form_field: 'files',
          headers: { Authorization: 'Bearer <same JWT as Hermes web app / HERMES_MCP_TOKEN>' },
          curl_example: `curl -X POST "BASE${pathSuffix}" -H "Authorization: Bearer TOKEN" -F "files=@/path/to/file.jpg"`,
          url_examples: {
            web_app_typical:
              'If the Hermes UI is at https://HOST/hermes/ then the API is usually https://HOST/hermes/api/notes/{note_id}/attachments',
            api_on_port_3000: `http://127.0.0.1:3000/api/notes/{note_id}/attachments`,
          },
          ...(publicBase
            ? { your_configured_base_example: `${publicBase}${pathSuffix}` }
            : {
                configure:
                  'Set HERMES_PUBLIC_API_URL in server .env (e.g. https://tailnet/hermes) to get an exact URL in this tool response.',
              }),
          why_claude_http_upload_fails:
            'Claude code execution / browser tools often run in a network-isolated container with no route to your home server or Tailscale IP—multipart from inside that sandbox will fail with "network blocked". The user should run curl on their own machine, or attach small files via hermes_attach_files (base64 through MCP, which hits Hermes from the MCP server).',
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  } catch (err) {
    const st = err.status;
    if (st === 401 || st === 403) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Hermes API unauthorized (JWT missing or invalid).',
                fix: [
                  'On the Hermes server: add HERMES_MCP_TOKEN=<jwt> to server/.env (same value as browser localStorage key hermes_token after you log in to the web app), then restart Hermes.',
                  'If your MCP client supports headers: send Authorization: Bearer <that_jwt> on MCP requests.',
                  'Tokens expire; log in again and update HERMES_MCP_TOKEN if this used to work.',
                ],
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}
