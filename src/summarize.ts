function formatDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getDescription(entry: any): string {
  if (entry.operation) return entry.operation;

  if (entry.type === "user") {
    const content = entry.message?.content?.[0];
    if (content?.type === "tool_result") {
      const toolId = content.tool_use_id?.slice(-8) ?? "";
      if (content.is_error) return `Tool error (${toolId})`;
      return `Tool result (${toolId})`;
    }
    if (content?.type === "text") {
      return content.text?.slice(0, 50) + "..." || "text";
    }
    return "user message";
  }

  if (entry.type === "assistant") {
    const content = entry.message?.content;
    if (!content) return "assistant";

    const parts: string[] = [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        parts.push(`text: "${c.text.slice(0, 30)}..."`);
      }
      if (c.type === "tool_use") {
        const input = c.input;
        if (c.name === "Read")
          parts.push(`Read: ${input?.file_path?.split("/").pop()}`);
        else if (c.name === "Write")
          parts.push(`Write: ${input?.file_path?.split("/").pop()}`);
        else if (c.name === "Skill") parts.push(`Skill: ${input?.skill}`);
        else parts.push(c.name);
      }
    }
    return parts.join(", ") || "assistant";
  }

  return entry.type ?? "—";
}

export function summarize(input: string): string {
  const lines = input
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  let prevTime: number | null = null;
  const output: string[] = [];

  output.push("| Timestamp | Delta | Type | Description |");
  output.push("|-----------|-------|------|-------------|");

  for (const entry of lines) {
    const ts = new Date(entry.timestamp).getTime();
    const delta = prevTime ? ts - prevTime : 0;

    const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
    const deltaStr = prevTime ? formatDelta(delta) : "—";
    const type = entry.type ?? entry.operation ?? "unknown";
    const desc = getDescription(entry);

    output.push(`| ${time} | ${deltaStr} | ${type} | ${desc} |`);
    prevTime = ts;
  }

  return output.join("\n");
}
