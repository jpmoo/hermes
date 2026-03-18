/**
 * Shared Hermes MCP tool definitions and call handler (stdio + Streamable HTTP).
 */

export const TOOL_DEFS = [
  {
    name: 'hermes_create_note',
    description:
      'Create a root note or reply. Optional attachments: pass attachments or files (same as hermes_add_attachments) to upload base64-encoded files in one step. Alternatively create empty then call hermes_add_attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        parent_id: { type: 'string' },
        external_anchor: { type: 'string' },
        attachments: {
          type: 'array',
          description: 'Optional files to attach immediately (base64 per file). Same shape as hermes_add_attachments files.',
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
          description: 'Alias for attachments',
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
  { name: 'hermes_get_thread', description: 'Retrieve a thread by root note ID.', inputSchema: { type: 'object', properties: { root_id: { type: 'string' } }, required: ['root_id'] } },
  { name: 'hermes_search_semantic', description: 'Query notes by semantic similarity.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] } },
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
    description:
      'Attach one or more files to an existing note. Each file must be base64-encoded (standard encoding). Max 20 files per call; same size limits as the web app.',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'UUID of the note to attach files to' },
        files: {
          type: 'array',
          description: 'Each entry: base64 (or data) required; filename and mime_type optional',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              mime_type: { type: 'string' },
              base64: { type: 'string', description: 'File bytes as base64' },
              data: { type: 'string', description: 'Alias for base64' },
            },
          },
        },
      },
      required: ['note_id', 'files'],
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
                        'Note created but this MCP session cannot upload files here; call hermes_add_attachments with note id.',
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
                      hint: 'Note exists; retry with hermes_add_attachments using note id above.',
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
        const { root_id } = args || {};
        const body = await api(`/notes/thread/${root_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      }
      case 'hermes_search_semantic': {
        const { q, limit } = args || {};
        const body = await api(`/notes/search-semantic?q=${encodeURIComponent(q || '')}&limit=${limit || 20}`);
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
      case 'hermes_add_attachments': {
        if (!uploadAttachments) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Attachments upload not available' }) }],
            isError: true,
          };
        }
        const { note_id, files } = args || {};
        const list = Array.isArray(files) ? files : [];
        const body = await uploadAttachments(note_id, list);
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
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
