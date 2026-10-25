// WebMCP: the proposed browser standard (navigator.modelContext) that lets an AI assistant built into the
// browser use a page through named tools instead of clicking around. PayPal is adopting it for Agent Ready.
// Browsers without it ignore this file; nothing on the page depends on it.
export function registerWebMcpTools(tools) {
  const ctx = typeof navigator !== 'undefined' ? navigator.modelContext : null;
  if (!ctx) return false;
  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    async execute(input) {
      try {
        const out = await t.execute(input || {});
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  }));
  try {
    if (typeof ctx.registerTool === 'function') defs.forEach((d) => ctx.registerTool(d));
    else if (typeof ctx.provideContext === 'function') ctx.provideContext({ tools: defs });
    else return false;
    return true;
  } catch (err) {
    console.warn('WebMCP registration failed', err);
    return false;
  }
}
