# Ronny J ops agent

Back-office Claude agent for Jason and the 17 Hertz team. Lives at `/dashboard/chat`.

## What's here

- `tools.ts` — read-only + draft-only tools over the Supabase surface. v0.1 scope: search vendors, look up invoices, list events/reminders, draft emails.
- `system-prompt.ts` — the "you are the ops assistant" brief. Edit here when Claude's tone or scope drifts.
- `run.ts` — the tool-use loop. Takes a `messages[]` history, calls Claude with the ops tools, runs any tool_use blocks, feeds results back, returns the final reply.
- `../../app/api/agent/chat/route.ts` — team-member-gated POST endpoint.
- `../../app/dashboard/chat/page.tsx` + `chat-client.tsx` — the chat UI.

## Trust ramp

v0.1 is read-only + drafts. Claude cannot:
- approve/reject invoices
- send emails or SMS
- change ACH, legal name, or any vendor row
- move money
- publish anything externally

When Claude wants to write, it drafts the exact wording in its text response. Jason clicks the actual button.

## Adding a tool

1. Define a new `ToolDef` in `tools.ts` — schema + async executor.
2. Add it to the `tools` registry at the bottom of the file.
3. If the tool performs a write, bump the README — this is a trust boundary change.

## Model

Currently `claude-sonnet-4-5-20250929`. Swap via `MODEL` in `run.ts`.

## Conversation persistence

None. State lives in the client component. Refreshing the page starts a new conversation. Good enough for v0.1; revisit if Jason wants recall across sessions.

## Failure modes we've thought about

- **Infinite tool loop** — `MAX_ITERATIONS = 8` in `run.ts` caps it.
- **Tool throws** — `runTool` catches and returns `{error: "..."}` as normal tool_result content. Claude sees it and recovers.
- **Context bloat** — route rejects conversations >40 turns.
- **Prompt injection via tool results** — system prompt explicitly tells Claude to treat tool content as untrusted data, not instructions.
