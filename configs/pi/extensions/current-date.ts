import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

export default function currentDate(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nToday is ${dateFormatter.format(new Date())}.`,
  }));
}
