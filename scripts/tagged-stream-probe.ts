import { createSubscribedSessionHarness } from "../src/agents/embedded-agent-subscribe.e2e-harness.js";

function repeatTo(unit: string, chars: number): string {
  return unit.repeat(Math.max(1, Math.ceil(chars / unit.length))).slice(0, chars);
}

const chars = Number(process.argv[2] ?? 32000);
const chunk = Number(process.argv[3] ?? 4);
const body = repeatTo("The quick brown fox jumps over the lazy dog. ", chars);
const doc = `<final>${body}</final>`;
const partials: string[] = [];
const blocks: string[] = [];
const { emit } = createSubscribedSessionHarness({
  runId: "bench",
  enforceFinalTag: true,
  onPartialReply: (data) => {
    partials.push(
      `${data.replace ? "R" : "a"}:${data.delta.length}:${data.text.length}:${JSON.stringify(data.text.slice(-40))}`,
    );
  },
  onBlockReply: (data) => {
    blocks.push(typeof data === "string" ? data : JSON.stringify(data));
  },
  blockReplyBreak: "message_end",
});
const message = { role: "assistant", phase: "final_answer", content: [] as unknown[] };
emit({ type: "message_start", message });
const cpuStart = process.cpuUsage();
const started = process.hrtime.bigint();
for (let at = 0; at < doc.length; at += chunk) {
  const prefix = doc.slice(0, at + chunk);
  message.content = [{ type: "text", text: prefix }];
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: doc.slice(at, at + chunk),
    },
  });
}
emit({
  type: "message_end",
  message: { ...message, content: [{ type: "text", text: doc }] },
});
const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
const cpu = process.cpuUsage(cpuStart);
const blockText = blocks.join("");
console.log(
  `chars=${doc.length} wallMs=${wallMs.toFixed(0)} cpuMs=${((cpu.user + cpu.system) / 1000).toFixed(0)} partials=${partials.length} blockLen=${blockText.length}`,
);
console.log(`blockHead=${JSON.stringify(blockText.slice(0, 80))}`);
console.log(`blockTail=${JSON.stringify(blockText.slice(-80))}`);
console.log(`partialLog=${JSON.stringify(partials.slice(-6))}`);
